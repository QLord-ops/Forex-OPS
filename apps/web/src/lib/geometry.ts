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
