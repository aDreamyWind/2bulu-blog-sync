import { chromium } from 'playwright-core'

const ORIGIN = 'https://www.2bulu.com'
const LIST_PATH = '/spaceindex/my_track.htm'
const DETAILS_PATH = '/track/track_detail.htm'
const POSITIONS_PATH = '/track/get_track_positions_list.htm'
const TIMEOUT = 15_000

export async function withBrowser(task) {
  let browser
  try {
    browser = await chromium.connectOverCDP('chrome', {
      noDefaults: true,
      timeout: 45_000,
    })
  } catch {
    throw new Error('无法连接 Chrome。请启用远程调试，并在 Chrome 中允许本次连接。')
  }

  try {
    return await task(browser)
  } finally {
    await browser.close().catch(() => {})
  }
}

function accountContext(browser) {
  const contexts = browser.contexts()
  const openListPage = contexts
    .flatMap((context) => context.pages())
    .find((page) => {
      const url = new URL(page.url())
      return url.origin === ORIGIN && url.pathname === LIST_PATH && !url.search
    })
  const context = openListPage?.context() ?? contexts[0]
  if (!context) throw new Error('Chrome 没有可用的浏览器会话。')
  return { context, openListPage }
}

async function closeTemporaryPage(page) {
  await page?.close().catch(() => {})
}

function requiresVerification(page) {
  return page
    ?.evaluate(
      () =>
        performance.getEntriesByType('navigation')[0]?.responseStatus === 468 ||
        /客户端异常|人机验证|安全验证/.test(document.body?.innerText ?? ''),
    )
    .catch(() => false)
}

function canonicalId(value) {
  if (!value) return null
  try {
    for (let iteration = 0; iteration < 5 && value.includes('%'); iteration += 1) {
      value = decodeURIComponent(value)
    }
    return value.replaceAll(' ', '+')
  } catch {
    return null
  }
}

function detailId(urlString) {
  const url = new URL(urlString)
  if (url.origin !== ORIGIN) return null
  const raw =
    url.pathname === DETAILS_PATH
      ? url.searchParams.get('trackId')
      : url.pathname.match(/^\/track\/t-(.+)\.htm$/)?.[1]
  return canonicalId(raw)
}

async function openDetail(context, listPage, sourceId) {
  const url = `${ORIGIN}${DETAILS_PATH}?trackId=${sourceId}`
  if (listPage) {
    const link = listPage.locator(`#my_track a.track_name[id="${sourceId}"]`)
    const [page] = await Promise.all([
      context.waitForEvent('page', { timeout: TIMEOUT }),
      (await link.count()) > 0
        ? link.evaluate((element) => element.click())
        : listPage.evaluate((url) => {
            window.open(url)
          }, url),
    ])
    await page.waitForURL((url) => detailId(url.href) === canonicalId(sourceId), {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT,
    })
    return page
  }
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    return page
  } catch (error) {
    await closeTemporaryPage(page)
    throw error
  }
}

export async function listTracks(browser) {
  const { context, openListPage } = accountContext(browser)
  let temporaryPage
  let result
  try {
    const page = openListPage ?? (temporaryPage = await context.newPage())
    if (temporaryPage) {
      await page.goto(`${ORIGIN}${LIST_PATH}`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    }
    await page.waitForFunction(
      () => {
        const list = document.querySelector('#my_track')
        return (
          list &&
          (list.querySelector('.pagination, .guiji') ||
            /没有相关|暂无轨迹|无轨迹/.test(list.innerText))
        )
      },
      null,
      { timeout: TIMEOUT },
    )

    result = await page.evaluate(
      async ({ timeout, origin }) => {
        if (
          location.origin !== origin ||
          ![...document.querySelectorAll('.tab li.on')].some(
            (tab) => tab.textContent.trim() === '我的轨迹',
          )
        ) {
          return { error: '请在 Chrome 登录两步路并打开自己的「我的轨迹」页。' }
        }

        function readPage(root) {
          const rows = [...root.querySelectorAll('.guiji')]
          if (
            rows.length &&
            rows[0].querySelector('.caozuo li.l1')?.textContent.trim() !== '编辑信息'
          ) {
            throw new Error('无法确认轨迹列表属于当前账号。')
          }
          const tracks = rows.map((row) => {
            const link = row.querySelector('a.track_name[onclick*="toMyTrackDetail"]')
            const sourceId = link?.id
            if (!sourceId || row.id !== `track_${sourceId}`) {
              throw new Error('轨迹列表结构已变化，无法读取轨迹编号。')
            }
            return { sourceId, title: link.textContent.trim() }
          })
          const pagination = root.querySelector('.pagination')?.getAttribute('page')
          const totalPages = Number(pagination?.match(/\btotalPage\s*:\s*(\d+)/)?.[1] ?? 1)
          const pageNumber = Number(pagination?.match(/\bpageNumber\s*:\s*(\d+)/)?.[1] ?? 1)
          return { tracks, totalPages, pageNumber }
        }

        try {
          const accountId = typeof userId === 'undefined' ? window.userId : userId
          const isSelf = typeof ifSelf === 'undefined' ? window.ifSelf : ifSelf
          if (!accountId || isSelf == null || typeof window.$?.ajax !== 'function') {
            return { error: '无法读取轨迹分页，请刷新「我的轨迹」页后重试。' }
          }

          async function fetchPage(number) {
            const html = await new Promise((resolve, reject) => {
              window.$.ajax({
                url: `/spaceindex/show_my_track.htm?${Date.now()}`,
                type: 'POST',
                data: { pageSize: 10, pageNumber: number, userId: accountId, ifSelf: isSelf },
                dataType: 'html',
                timeout,
                success: resolve,
                error: () => reject(new Error('读取轨迹分页失败，请检查登录状态后重试。')),
              })
            })
            const documentPage = new DOMParser().parseFromString(html, 'text/html')
            return readPage(documentPage.querySelector('#my_track') ?? documentPage.body)
          }

          const first = await fetchPage(1)
          const tracks = new Map(first.tracks.map((track) => [track.sourceId, track]))
          for (let number = 2; number <= first.totalPages; number += 1) {
            const next = await fetchPage(number)
            if (next.pageNumber !== number || !next.tracks.length) {
              return { error: '轨迹分页结果不完整，请刷新「我的轨迹」页后重试。' }
            }
            for (const track of next.tracks) tracks.set(track.sourceId, track)
          }

          return { tracks: [...tracks.values()] }
        } catch (error) {
          const knownErrors = [
            '无法确认轨迹列表属于当前账号。',
            '轨迹列表结构已变化，无法读取轨迹编号。',
            '读取轨迹分页失败，请检查登录状态后重试。',
          ]
          return {
            error: knownErrors.includes(error.message) ? error.message : '无法读取轨迹列表。',
          }
        }
      },
      { timeout: TIMEOUT, origin: ORIGIN },
    )
  } catch {
    throw new Error(
      '无法打开「我的轨迹」页。请检查两步路登录状态，并在 Chrome 中完成可能出现的验证。',
    )
  } finally {
    await closeTemporaryPage(temporaryPage)
  }
  if (result.error) throw new Error(result.error)
  return result.tracks
}

export async function readTrack(browser, sourceId) {
  if (typeof sourceId !== 'string' || !/^[a-z0-9_+=/%.-]+$/i.test(sourceId)) {
    throw new Error('所选轨迹的编号格式无效。')
  }

  const expected = canonicalId(sourceId)
  if (!expected) throw new Error('所选轨迹的编号格式无效。')
  const { context, openListPage } = accountContext(browser)
  let page = context.pages().find((page) => detailId(page.url()) === expected)
  let temporaryPage
  try {
    page ??= temporaryPage = await openDetail(context, openListPage, sourceId)
    if (await requiresVerification(page)) throw new Error('两步路要求验证。')
    const requestHandle = await page.waitForFunction(
      ({ origin, path }) => {
        const client = typeof request !== 'undefined' ? request : window.request
        if (location.origin !== origin || typeof client?.get !== 'function') return false
        const positions = performance
          .getEntriesByType('resource')
          .map((entry) => new URL(entry.name))
          .filter(
            (url) =>
              url.origin === origin && url.pathname === path && url.searchParams.has('trackId'),
          )
        return positions.length > 0
          ? positions.map((url) => Object.fromEntries(url.searchParams))
          : false
      },
      { origin: ORIGIN, path: POSITIONS_PATH },
      { timeout: TIMEOUT },
    )
    const requests = await requestHandle.jsonValue()
    await requestHandle.dispose()
    const params = requests.find((params) => canonicalId(params.trackId) === expected)
    if (!params || detailId(page.url()) !== expected) throw new Error('轨迹编号不匹配。')

    return await page.evaluate(
      async ({ requestUrl, params, timeout }) => {
        const points = typeof trackLngs === 'undefined' ? window.trackLngs : trackLngs
        const trackMap = typeof map === 'undefined' ? window.map : map
        const overlays = trackMap?.getOverlays?.()
        if (Array.isArray(points) && points.length && Array.isArray(overlays)) {
          const sizes = overlays.flatMap((overlay) => {
            const line = overlay.getPath?.() ?? overlay.getLatLngs?.() ?? overlay.getPoints?.()
            return Array.isArray(line) && line.length ? [line.length] : []
          })
          if (sizes.reduce((sum, size) => sum + size, 0) === points.length) {
            let offset = 0
            return sizes.map((size) => {
              const line = points.slice(offset, offset + size)
              offset += size
              return line.map(({ lng, lat, elevation }) => ({ lng, lat, elev: elevation }))
            })
          }
        }

        const client = typeof request !== 'undefined' ? request : window.request
        let timer
        try {
          const response = await Promise.race([
            client.get(requestUrl, {
              params,
              decrypt: true,
              responseType: 'arraybuffer',
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('读取轨迹超时。')), timeout)
            }),
          ])

          function decode(value) {
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
              value = new TextDecoder().decode(value)
            }
            return typeof value === 'string' ? JSON.parse(value) : value
          }

          const data = decode(response)
          const segments = decode(data?.data ?? data)?.trackPositions
          if (!Array.isArray(segments) || !segments.length || !segments.every(Array.isArray)) {
            throw new Error('轨迹数据缺失。')
          }
          return segments.map((line) => line.map(({ lng, lat, elev }) => ({ lng, lat, elev })))
        } finally {
          clearTimeout(timer)
        }
      },
      { requestUrl: ORIGIN + POSITIONS_PATH, params, timeout: TIMEOUT },
    )
  } catch {
    if (await requiresVerification(page)) {
      temporaryPage = undefined
      throw new Error('两步路要求验证。请在 Chrome 完成详情页的验证，再运行 sync。')
    }
    throw new Error(
      '无法读取所选轨迹。请检查这条轨迹在 Chrome 中能否打开，以及是否需要重新登录或验证。',
    )
  } finally {
    await closeTemporaryPage(temporaryPage)
  }
}
