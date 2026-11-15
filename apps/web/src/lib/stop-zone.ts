import type { Coordinate } from '../types/domain'

/** The server's rules (services/webfleet.ts, `zoneRadiusOf`): a stop is a zone of 1 km unless the dispatcher chose a radius. */
export const DEFAULT_ZONE_METERS = 1000
const MIN_ZONE_METERS = 250
const SAME_PLACE_METERS = 300

type ZoneStop = { latitude: number; longitude: number; completedAt?: string | null; arrivalRadiusMeters?: number | null }

export function metersBetween(a: Coordinate, b: Coordinate): number {
  const rad = Math.PI / 180
  const dLat = (b[1] - a[1]) * rad
  const dLon = (b[0] - a[0]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h))
}

/** A circle on the ground as a polygon: MapLibre has no circle measured in metres. */
export function circlePolygon(center: Coordinate, radiusMeters: number, steps = 64): GeoJSON.Feature<GeoJSON.Polygon> {
  const latStep = radiusMeters / 110_574
  const lonStep = radiusMeters / (111_320 * Math.cos(center[1] * Math.PI / 180))
  const ring = Array.from({ length: steps + 1 }, (_, index) => {
    const angle = (index % steps) / steps * 2 * Math.PI
    return [center[0] + lonStep * Math.cos(angle), center[1] + latStep * Math.sin(angle)]
  })
  return { type: 'Feature', properties: { radiusMeters }, geometry: { type: 'Polygon', coordinates: [ring] } }
}

/**
 * The zones the truck still has to reach, one per place: stops at the same spot (unloading and loading at one plant) share
 * a circle, and with the next stop in the same town the zone ends halfway to it.
 */
export function stopZones(stops: ZoneStop[]): Array<{ center: Coordinate; radiusMeters: number }> {
  const zones: Array<{ center: Coordinate; radiusMeters: number }> = []
  const at = (stop: ZoneStop): Coordinate => [stop.longitude, stop.latitude]
  let index = 0
  while (index < stops.length) {
    const head = stops[index]
    let next = index + 1
    while (next < stops.length && metersBetween(at(stops[next]), at(head)) <= SAME_PLACE_METERS) next += 1
    if (stops.slice(index, next).some((stop) => !stop.completedAt)) {
      const nextDistance = next < stops.length ? metersBetween(at(stops[next]), at(head)) : Number.POSITIVE_INFINITY
      zones.push({ center: at(head), radiusMeters: head.arrivalRadiusMeters ?? Math.max(MIN_ZONE_METERS, Math.min(DEFAULT_ZONE_METERS, nextDistance / 2)) })
    }
    index = next
  }
  return zones
}

/** Latitude first, as Google Maps and a navigator take it: "51.31234, 9.48012". */
export function formatCoordinate(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
}

export function googleMapsUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps?q=${latitude.toFixed(5)},${longitude.toFixed(5)}`
}

export function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} м` : `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0).replace('.', ',')} км`
}
