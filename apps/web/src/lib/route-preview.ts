import type { Coordinate, RoadSegment, TrafficSegment } from '../types/domain.js'

export type MapRouteStop = { coordinate: Coordinate; label: string; title: string }
export type MapRouteAlternative = { id: string; geometry: Coordinate[]; label: string }
export type MapRoutePreview = {
  geometry: Coordinate[]; label: string; stops?: MapRouteStop[]; trafficSegments?: TrafficSegment[]; roadSegments?: RoadSegment[]
  /** The variants not chosen right now; they stay on the map, grey, and can be clicked. */
  alternatives?: MapRouteAlternative[]
  onSelectAlternative?: (id: string) => void
  /** Same key = same route search: the map keeps its camera when only the chosen variant changes. */
  key?: string
}
let current: MapRoutePreview | null = null
const listeners = new Set<() => void>()
export const getRoutePreview = () => current
export function subscribeRoutePreview(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function setRoutePreview(preview: MapRoutePreview | null) {
  current = preview
  listeners.forEach((listener) => listener())
}

/** Only accept provider-calculated paths, never fabricate a line from stop addresses. */
export function previewGeometry(value: unknown): Coordinate[] {
  if (!value || typeof value !== 'object') return []
  const data = value as Record<string, unknown>
  if (Array.isArray(data.geometry)) {
    const points = data.geometry.map((point): Coordinate | null => {
      if (!point || typeof point !== 'object') return null
      const [lng, lat] = Array.isArray(point) ? point : [(point as Record<string, unknown>).longitude, (point as Record<string, unknown>).latitude]
      return typeof lng === 'number' && typeof lat === 'number' && Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90 ? [lng, lat] : null
    })
    return points.length >= 2 && points.every((point) => point !== null) ? points as Coordinate[] : []
  }
  if (Array.isArray(data.routes)) {
    const paths = data.routes.map(previewGeometry)
    return paths.length && paths.every((path) => path.length >= 2) ? paths.flat() : []
  }
  return data.after ? previewGeometry(data.after) : []
}
