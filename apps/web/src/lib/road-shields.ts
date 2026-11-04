import type { Coordinate, RoadSegment } from '../types/domain'

export interface RoadShield {
  id: string
  road: string
  kind: 'A' | 'B'
  coordinate: Coordinate
  /** Lower draws first when shields compete for space: Autobahn before Bundesstraße, long stretches first. */
  priority: number
}

// A junction stub of a few hundred metres is not worth a shield; long Autobahn stretches get one every ~80 km.
const MIN_SHIELD_METERS = 2_000
const SHIELD_EVERY_METERS = 80_000

function metersBetween(a: Coordinate, b: Coordinate) {
  const rad = Math.PI / 180
  const dLat = (b[1] - a[1]) * rad
  const dLon = (b[0] - a[0]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

function pointAt(route: Coordinate[], cumulative: number[], meters: number, from: number, to: number): Coordinate {
  for (let index = from + 1; index <= to; index += 1) {
    if (cumulative[index] < meters) continue
    const piece = cumulative[index] - cumulative[index - 1]
    const t = piece > 0 ? (meters - cumulative[index - 1]) / piece : 0
    const [a, b] = [route[index - 1], route[index]]
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }
  return route[to]
}

/** Where to put the A7 / B3 shields on the drawn route; only the part ahead of `startIndex` (the truck) gets them. */
export function roadShields(route: Coordinate[], segments: RoadSegment[] | undefined, options: { startIndex?: number } = {}): RoadShield[] {
  if (route.length < 2 || !segments?.length) return []
  const cumulative = [0]
  for (let index = 1; index < route.length; index += 1) cumulative.push(cumulative[index - 1] + metersBetween(route[index - 1], route[index]))
  const startIndex = Math.max(0, Math.min(route.length - 1, Math.floor(options.startIndex ?? 0)))

  const shields: Array<RoadShield & { meters: number }> = []
  for (const segment of segments) {
    const match = /^([AB])(\d{1,3}[a-z]?)$/.exec(segment.road ?? '')
    if (!match) continue
    const from = Math.max(startIndex, Math.floor(segment.from))
    const to = Math.min(route.length - 1, Math.floor(segment.to))
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue
    const length = cumulative[to] - cumulative[from]
    if (length < MIN_SHIELD_METERS) continue
    const count = Math.max(1, Math.floor(length / SHIELD_EVERY_METERS))
    for (let part = 0; part < count; part += 1) {
      shields.push({
        id: `${segment.road}-${segment.from}-${part}`,
        road: segment.road,
        kind: match[1] as 'A' | 'B',
        coordinate: pointAt(route, cumulative, cumulative[from] + length * (part + 0.5) / count, from, to),
        priority: 0,
        meters: length
      })
    }
  }
  return shields
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'A' ? -1 : 1) || b.meters - a.meters)
    .map((shield, index) => ({ id: shield.id, road: shield.road, kind: shield.kind, coordinate: shield.coordinate, priority: index }))
}

export const roadShieldLabel = (shield: Pick<RoadShield, 'kind' | 'road'>) => `${shield.kind === 'A' ? 'Автобан' : 'Бундесштрассе'} ${shield.road}`

type Box = { left: number; top: number; right: number; bottom: number }

/** Keeps shields that fit without covering each other or a jam icon; the rest wait for a closer zoom. */
export function visibleShields(candidates: Array<{ id: string; box: Box }>, blockers: Box[], gap = 4): Set<string> {
  const taken = [...blockers]
  const visible = new Set<string>()
  const hits = (a: Box, b: Box) => a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top
  for (const candidate of candidates) {
    if (taken.some((box) => hits(candidate.box, box))) continue
    taken.push(candidate.box)
    visible.add(candidate.id)
  }
  return visible
}
