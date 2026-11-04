import type { Coordinate, TrafficLevel, TrafficSegment } from '../types/domain'

export interface TrafficIncident {
  id: string
  level: TrafficLevel
  delaySeconds: number
  lengthMeters: number
  speedKmh: number | null
  /** Along the route from `startIndex` (the truck, or the route start) to where the jam begins. */
  distanceAheadMeters: number
  coordinate: Coordinate
}

const SEVERITY: Record<TrafficLevel, number> = { SLOW: 1, JAM: 2, STANDSTILL: 3, CLOSED: 4 }
const MAX_GAP_POINTS = 1

function metersBetween(a: Coordinate, b: Coordinate) {
  const rad = Math.PI / 180
  const dLat = (b[1] - a[1]) * rad
  const dLon = (b[0] - a[0]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Joins neighbouring congested pieces into one jam; every jam ahead gets an icon with what it costs (owner's decision 2026-11-04). */
export function trafficIncidents(route: Coordinate[], segments: TrafficSegment[] | undefined, options: { startIndex?: number } = {}): TrafficIncident[] {
  if (route.length < 2 || !segments?.length) return []
  const cumulative = [0]
  for (let index = 1; index < route.length; index += 1) cumulative.push(cumulative[index - 1] + metersBetween(route[index - 1], route[index]))
  const startIndex = Math.max(0, Math.min(route.length - 1, Math.floor(options.startIndex ?? 0)))

  const valid = segments
    .map((segment) => ({ ...segment, from: Math.max(0, Math.floor(segment.from)), to: Math.min(route.length - 1, Math.floor(segment.to)) }))
    .filter((segment) => Number.isFinite(segment.from) && Number.isFinite(segment.to) && segment.to > segment.from)
    .sort((a, b) => a.from - b.from)

  const merged: Array<{ from: number; to: number; level: TrafficLevel; delaySeconds: number; speedKmh: number | null }> = []
  for (const segment of valid) {
    const last = merged.at(-1)
    const delay = Math.max(0, segment.delaySeconds ?? 0)
    const speed = typeof segment.speedKmh === 'number' && Number.isFinite(segment.speedKmh) ? segment.speedKmh : null
    if (last && segment.from - last.to <= MAX_GAP_POINTS) {
      last.to = Math.max(last.to, segment.to)
      last.delaySeconds += delay
      if (SEVERITY[segment.level] > SEVERITY[last.level]) last.level = segment.level
      if (speed !== null) last.speedKmh = last.speedKmh === null ? speed : Math.min(last.speedKmh, speed)
    } else {
      merged.push({ from: segment.from, to: segment.to, level: segment.level, delaySeconds: delay, speedKmh: speed })
    }
  }

  return merged
    .filter((jam) => jam.to > startIndex)
    .map((jam) => {
      // A jam the truck is already in is reported from the truck onwards.
      const from = Math.max(jam.from, startIndex)
      return {
        id: `${jam.from}-${jam.to}`,
        level: jam.level,
        delaySeconds: jam.delaySeconds,
        lengthMeters: cumulative[jam.to] - cumulative[from],
        speedKmh: jam.speedKmh,
        distanceAheadMeters: cumulative[from] - cumulative[startIndex],
        coordinate: route[from]
      }
    })
}

export const INCIDENT_TITLES: Record<TrafficLevel, string> = { SLOW: 'Замедление', JAM: 'Пробка', STANDSTILL: 'Стоит', CLOSED: 'Перекрыто' }

export function formatKm(meters: number) {
  const km = meters / 1000
  return `${km < 10 ? km.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : Math.round(km).toLocaleString('ru-RU')} км`
}

export function formatDelay(seconds: number) {
  if (seconds > 0 && seconds < 60) return '<1 мин'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `+${minutes} мин`
  return `+${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
}
