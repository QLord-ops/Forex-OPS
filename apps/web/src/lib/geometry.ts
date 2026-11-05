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

export function splitRouteAtCoordinate(route: Coordinate[], coordinate?: Coordinate | null) {
  if (!route.length || !coordinate) return { travelledGeometry: [], remainingGeometry: route }
  if (route.length === 1) return { travelledGeometry: route, remainingGeometry: route }

  let closestIndex = 0
  let closestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < route.length; index += 1) {
    const longitude = route[index][0] - coordinate[0]
    const latitude = route[index][1] - coordinate[1]
    const distance = longitude * longitude + latitude * latitude
    if (distance < closestDistance) {
      closestDistance = distance
      closestIndex = index
    }
  }

  const closest = route[closestIndex]
  const isExactPoint = closest[0] === coordinate[0] && closest[1] === coordinate[1]
  return {
    travelledGeometry: isExactPoint ? route.slice(0, closestIndex + 1) : [...route.slice(0, closestIndex + 1), coordinate],
    remainingGeometry: [coordinate, ...route.slice(closestIndex + 1)]
  }
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
