import type { Coordinate, RouteGeometry } from '../types/domain'

export function geometryToCoordinates(geometry?: RouteGeometry | null): Coordinate[] {
  if (!geometry) return []

  if (typeof geometry === 'string') {
    try {
      const parsed = JSON.parse(geometry) as RouteGeometry
      return geometryToCoordinates(parsed)
    } catch {
      return []
    }
  }

  if (Array.isArray(geometry)) {
    return geometry.filter(isCoordinate)
  }

  if (geometry.type === 'LineString') {
    return geometry.coordinates.filter(isCoordinate)
  }

  return []
}

export function toLineString(geometry?: RouteGeometry | null) {
  return {
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: geometryToCoordinates(geometry)
    },
    properties: {}
  }
}

export function stopCoordinates(stops?: Array<{ longitude: number; latitude: number }>): Coordinate[] {
  return stops?.map((stop) => [stop.longitude, stop.latitude] as Coordinate).filter(isCoordinate) ?? []
}

/**
 * A route drawn in pieces: at each break index a new piece starts, so two stretches that do not meet
 * (where the truck left the old plan) are not joined by a straight line across the map.
 */
export function toBrokenLine(geometry?: RouteGeometry | null, breaks?: number[] | null) {
  const points = geometryToCoordinates(geometry)
  const cuts = [...new Set((breaks ?? []).filter((index) => Number.isInteger(index) && index > 0 && index < points.length))].sort((a, b) => a - b)
  if (!cuts.length) return toLineString(points)
  const bounds = [0, ...cuts, points.length]
  const lines = bounds.slice(0, -1).map((from, index) => points.slice(from, bounds[index + 1])).filter((line) => line.length >= 2)
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'MultiLineString' as const, coordinates: lines } }
}

export function boundsFor(coordinates: Coordinate[]) {
  if (!coordinates.length) return null

  // One pass: spreading a long TomTom polyline into Math.min overflows the call stack.
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  for (const [lng, lat] of coordinates) {
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }

  return [
    [minLng, minLat] as Coordinate,
    [maxLng, maxLat] as Coordinate
  ] as const
}

/** Closer than this the truck is on the route and the line runs to its GPS point; farther, it stays on the plan. */
export const ON_ROUTE_METERS = 300

/**
 * Splits the drawn route where the truck is: at the closest point of the line. The GPS point itself joins the line
 * only when it lies on the route, so a truck that left the plan does not get a straight line drawn to it.
 */
export function splitRouteAtCoordinate(route: Coordinate[], coordinate?: Coordinate | null) {
  if (!route.length || !coordinate) return { travelledGeometry: [], remainingGeometry: route }
  if (route.length === 1) return { travelledGeometry: route, remainingGeometry: route }

  const cosLat = Math.cos(coordinate[1] * Math.PI / 180)
  const toMeters = (point: Coordinate) => [(point[0] - coordinate[0]) * cosLat * 111_320, (point[1] - coordinate[1]) * 110_574]
  let best = { index: 0, t: 0, distance: Number.POSITIVE_INFINITY }
  for (let index = 0; index < route.length - 1; index += 1) {
    const [ax, ay] = toMeters(route[index])
    const [bx, by] = toMeters(route[index + 1])
    const dx = bx - ax, dy = by - ay
    const length = dx * dx + dy * dy
    const t = length > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0
    const px = ax + dx * t, py = ay + dy * t
    const distance = Math.hypot(px, py)
    if (distance < best.distance) best = { index, t, distance }
  }

  const [a, b] = [route[best.index], route[best.index + 1]]
  const onLine: Coordinate = best.t <= 0 ? a : best.t >= 1 ? b : [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t]
  const cut = best.distance <= ON_ROUTE_METERS ? coordinate : onLine
  const same = (p: Coordinate, q: Coordinate) => p[0] === q[0] && p[1] === q[1]
  const before = route.slice(0, best.index + 1).filter((point, index, all) => index < all.length - 1 || !same(point, cut))
  const after = route.slice(best.index + 1).filter((point, index) => index > 0 || !same(point, cut))
  return { travelledGeometry: [...before, cut], remainingGeometry: [cut, ...after] }
}

function isCoordinate(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  )
}

/** Slices a route into coloured stretches; free-flowing parts are drawn by the base line underneath. */
export function trafficFeatures(route: Coordinate[], segments: Array<{ from: number; to: number; level: string }> | undefined) {
  const features = (segments ?? []).flatMap((segment) => {
    const from = Math.max(0, Math.floor(segment.from))
    const to = Math.min(route.length - 1, Math.floor(segment.to))
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return []
    return [{ type: 'Feature' as const, properties: { level: segment.level }, geometry: { type: 'LineString' as const, coordinates: route.slice(from, to + 1) } }]
  })
  return { type: 'FeatureCollection' as const, features }
}
