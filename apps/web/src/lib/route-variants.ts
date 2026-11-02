import type { RouteLeg, RouteOption } from '../types/assistant'
import type { Coordinate, TrafficSegment } from '../types/domain'

/** «через A14 и A2», as Webfleet names its route variants. */
export function routeVia(option: RouteOption) {
  const [first, second] = option.mainRoads
  if (first && second) return `через ${first} и ${second}`
  if (first) return `через ${first}`
  return 'по местным дорогам'
}

export function chosenOption(leg: RouteLeg, index: number | undefined): RouteOption | undefined {
  return leg.options[index ?? 0] ?? leg.options[0]
}

/** Joins the chosen variant of every leg into one line, shifting congestion stretches with it. */
export function composeRoute(legs: RouteLeg[], choice: number[]) {
  const geometry: Coordinate[] = []
  const trafficSegments: TrafficSegment[] = []
  let distanceMeters = 0
  legs.forEach((leg, index) => {
    const option = chosenOption(leg, choice[index])
    if (!option) return
    const last = geometry.at(-1)
    const first = option.geometry[0]
    const skip = last && first && last[0] === first[0] && last[1] === first[1] ? 1 : 0
    const offset = geometry.length - skip
    for (const point of option.geometry.slice(skip)) geometry.push(point)
    for (const segment of option.trafficSegments) trafficSegments.push({ ...segment, from: segment.from + offset, to: segment.to + offset })
    distanceMeters += option.distanceMeters
  })
  return { geometry, trafficSegments, distanceMeters }
}

export function formatDrive(seconds: number) {
  const minutes = Math.max(0, Math.round(seconds / 60))
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours} ч ${String(minutes % 60).padStart(2, '0')} мин` : `${minutes} мин`
}

export function formatRouteKm(meters: number) {
  return meters < 10_000 ? `${(meters / 1000).toFixed(1).replace('.', ',')} км` : `${Math.round(meters / 1000)} км`
}

/** «+11 мин, +15 км к лучшему»: a difference always says what it is compared with. */
export function variantDelta(option: RouteOption, best: RouteOption) {
  const minutes = Math.round((option.durationSeconds - best.durationSeconds) / 60)
  const km = Math.round((option.distanceMeters - best.distanceMeters) / 1000)
  const signed = (value: number) => value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '±0'
  return `${signed(minutes)} мин, ${signed(km)} км к лучшему`
}

export function placeName(address: string) {
  const first = address.split(',')[0]?.trim() || address.trim()
  return first.length > 24 ? `${first.slice(0, 23)}…` : first
}
