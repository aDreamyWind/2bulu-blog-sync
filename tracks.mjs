const radians = (degrees) => (degrees * Math.PI) / 180

function pointFrom(raw) {
  const number = (value) => (value == null || String(value).trim() === '' ? NaN : Number(value))
  const lng = number(raw?.lng)
  const lat = number(raw?.lat)
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    Math.abs(lng) > 180 ||
    Math.abs(lat) > 90 ||
    (lng === 0 && lat === 0)
  )
    return null
  const elevation = number(raw?.elev)
  return { lng, lat, elevation: Number.isFinite(elevation) ? elevation : null }
}

function metersBetween(from, to) {
  const dLat = radians(to.lat - from.lat)
  const dLng = radians(to.lng - from.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLng / 2) ** 2
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, h)))
}

function pointAt(from, to, ratio) {
  if (ratio === 0) return [from.lng, from.lat]
  if (ratio === 1) return [to.lng, to.lat]
  const deltaLng = ((to.lng - from.lng + 540) % 360) - 180
  const lng = ((from.lng + ratio * deltaLng + 540) % 360) - 180
  return [lng, from.lat + ratio * (to.lat - from.lat)]
}

export function prepareTrack(segments, trimStartM, trimEndM) {
  const lines = []
  let totalDistance = 0

  for (const segment of segments) {
    let previous = null
    let edges = []
    for (const raw of segment) {
      const point = pointFrom(raw)
      if (previous && point) {
        const length = metersBetween(previous, point)
        if (length > 0) {
          edges.push({ from: previous, to: point, start: totalDistance, length })
          totalDistance += length
        }
      }
      if (!point && edges.length) {
        lines.push(edges)
        edges = []
      }
      previous = point
    }
    if (edges.length) lines.push(edges)
  }

  const end = totalDistance - trimEndM
  const coordinates = []
  let distance = 0
  let ascent = 0
  let hasElevation = false
  for (const line of lines) {
    const positions = []
    for (const { from, to, start, length } of line) {
      const fromRatio = Math.max(0, (trimStartM - start) / length)
      const toRatio = Math.min(1, (end - start) / length)
      if (fromRatio >= toRatio) continue
      if (!positions.length) positions.push(pointAt(from, to, fromRatio))
      positions.push(pointAt(from, to, toRatio))
      distance += length * (toRatio - fromRatio)
      if (from.elevation !== null && to.elevation !== null) {
        hasElevation = true
        ascent += Math.max(0, to.elevation - from.elevation) * (toRatio - fromRatio)
      }
    }
    if (positions.length) coordinates.push(positions)
  }

  if (!coordinates.length) throw new Error('没有可发布的路线坐标，请检查轨迹点或缩短裁剪距离。')
  return {
    geometry: { type: 'MultiLineString', coordinates },
    distanceKm: Math.round(distance) / 1000,
    ...(hasElevation ? { ascentM: Math.round(ascent) } : {}),
  }
}

export function validateSelection(config) {
  if (!Array.isArray(config?.tracks)) throw new Error('配置须包含 tracks 数组。')
  const slugs = new Set()
  return config.tracks.map((track, index) => {
    const label = `tracks[${index}]`
    const { sourceId, slug, title, date, trimStartM = 0, trimEndM = 0 } = track ?? {}
    if (typeof sourceId !== 'string' || !/^[\w%+/=-]{1,256}$/.test(sourceId))
      throw new Error(`${label} 的 sourceId 无效，请使用 list 的结果。`)
    if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slugs.has(slug)) {
      throw new Error(`${label} 须使用唯一的 slug，格式如 west-lake-1。`)
    }
    if (typeof title !== 'string' || !title.trim())
      throw new Error(`${label} 须设置用于公开展示的 title。`)
    if (date !== undefined) {
      const valid =
        typeof date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        Number.isFinite(Date.parse(date))
      if (!valid || new Date(date).toISOString().slice(0, 10) !== date)
        throw new Error(`${label} 的 date 须为 YYYY-MM-DD。`)
    }
    if (![trimStartM, trimEndM].every((value) => Number.isFinite(value) && value >= 0))
      throw new Error(`${label} 的裁剪距离须为非负米数。`)
    slugs.add(slug)
    return { sourceId, slug, title: title.trim(), date, trimStartM, trimEndM }
  })
}
