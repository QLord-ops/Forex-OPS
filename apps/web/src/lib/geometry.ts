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

export function boundsFor(coordinates: Coordinate[]) {
  if (!coordinates.length) return null

  const lngs = coordinates.map(([lng]) => lng)
  const lats = coordinates.map(([, lat]) => lat)

  return [
    [Math.min(...lngs), Math.min(...lats)] as Coordinate,
    [Math.max(...lngs), Math.max(...lats)] as Coordinate
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
