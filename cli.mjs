#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { prepareTrack, validateSelection } from './tracks.mjs'

const usage = `用法：
  2bulu-blog-sync list
  2bulu-blog-sync sync --config <选择文件> --output <GeoJSON> [--cache <目录>] [--refresh]

list 输出已登录 Chrome 中「我的轨迹」的可选条目。
sync 只导出配置中选中的轨迹，默认复用本机缓存。`

function cacheFile(cacheDir, track) {
  const key = JSON.stringify([1, track.sourceId, track.trimStartM, track.trimEndM])
  return join(cacheDir, createHash('sha256').update(key).digest('hex') + '.json')
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function writeAtomic(path, data, mode) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { mode, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function parseCachedRoute(data, slug) {
  const route = JSON.parse(data)
  const geometry = route?.geometry
  const coordinates = geometry?.coordinates
  const validPosition = (point) =>
    Array.isArray(point) &&
    point.length === 2 &&
    point.every(Number.isFinite) &&
    Math.abs(point[0]) <= 180 &&
    Math.abs(point[1]) <= 90
  const validDistance = (value) => Number.isFinite(value) && value >= 0
  if (
    geometry?.type !== 'MultiLineString' ||
    !Array.isArray(coordinates) ||
    !coordinates.length ||
    !coordinates.every(
      (line) => Array.isArray(line) && line.length >= 2 && line.every(validPosition),
    ) ||
    !validDistance(route.distanceKm) ||
    (route.ascentM !== undefined && !validDistance(route.ascentM))
  ) {
    throw new Error(`${slug} 的本地缓存格式不正确，请使用 --refresh 重新读取。`)
  }
  return {
    geometry: { type: 'MultiLineString', coordinates },
    distanceKm: route.distanceKm,
    ascentM: route.ascentM,
  }
}

async function sync(values) {
  if (!values.config || !values.output) throw new Error('sync 需要 --config 和 --output。')
  const output = resolve(values.output)
  if (output === resolve(values.config)) throw new Error('输出文件与选择文件须使用不同路径。')
  const selected = validateSelection(JSON.parse(await readFile(values.config, 'utf8')))
  const cacheDir = resolve(values.cache || join(homedir(), '.cache', '2bulu-blog-sync'))
  const entries = await Promise.all(
    selected.map(async (track) => {
      const path = cacheFile(cacheDir, track)
      const cached = values.refresh ? undefined : await readOptional(path)
      return {
        track,
        path,
        route: cached === undefined ? undefined : parseCachedRoute(cached, track.slug),
      }
    }),
  )
  const pending = entries.filter((entry) => !entry.route)

  if (pending.length) {
    const { withBrowser, listTracks, readTrack } = await import('./browser.mjs')
    await withBrowser(async (browser) => {
      const available = new Set((await listTracks(browser)).map((track) => track.sourceId))
      const missing = pending.find(({ track }) => !available.has(track.sourceId))
      if (missing)
        throw new Error(`当前「我的轨迹」列表未找到 ${missing.track.slug}，请确认账号和 sourceId。`)
      await mkdir(cacheDir, { recursive: true, mode: 0o700 })
      for (const entry of pending) {
        const { track, path } = entry
        const segments = await readTrack(browser, track.sourceId)
        entry.route = prepareTrack(segments, track.trimStartM, track.trimEndM)
        await writeAtomic(path, JSON.stringify(entry.route), 0o600)
      }
    })
  }

  const features = entries.map(({ track, route }) => ({
    type: 'Feature',
    id: track.slug,
    geometry: route.geometry,
    properties: {
      title: track.title,
      date: track.date,
      distanceKm: route.distanceKm,
      ascentM: route.ascentM,
    },
  }))
  const data = JSON.stringify({ type: 'FeatureCollection', features }) + '\n'
  if ((await readOptional(output)) !== data) {
    await mkdir(dirname(output), { recursive: true })
    await writeAtomic(output, data, 0o644)
  }
  console.log(
    `已生成 ${features.length} 条路线，重新读取 ${pending.length} 条，复用缓存 ${features.length - pending.length} 条。`,
  )
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      config: { type: 'string' },
      output: { type: 'string' },
      cache: { type: 'string' },
      refresh: { type: 'boolean' },
    },
  })
  const [command] = positionals
  if (values.help || (!command && !Object.keys(values).length)) return console.log(usage)
  if (positionals.length !== 1) throw new Error(usage)
  if (command === 'sync') return sync(values)
  if (command === 'list' && !Object.keys(values).length) {
    const { withBrowser, listTracks } = await import('./browser.mjs')
    const tracks = await withBrowser(listTracks)
    return console.log(JSON.stringify(tracks, null, 2))
  }
  throw new Error(usage)
}

main().catch((error) => {
  console.error(
    error instanceof SyntaxError ? '无法解析 JSON，请检查选择文件或本地缓存。' : error.message,
  )
  process.exitCode = 1
})
