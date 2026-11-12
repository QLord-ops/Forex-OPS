import { useEffect, useMemo, useState } from 'react'

import { api } from '../lib/api'
import { geometryToCoordinates, splitRouteAtCoordinate } from '../lib/geometry'
import type { CurrentPosition } from '../types/domain'
import { usePolling } from './usePolling'

export function useVehiclePosition(vehicleId: string, intervalMs = 10_000) {
  const summary = usePolling(() => api.currentPosition(vehicleId, false), intervalMs, Boolean(vehicleId), vehicleId || 'none')
  const [geometry, setGeometry] = useState<{ vehicleId: string; data: CurrentPosition } | null>(null)

  useEffect(() => {
    const geometryVersion = summary.data?.geometryVersion
    if (!vehicleId || !geometryVersion) { setGeometry(null); return }
    if (geometry?.vehicleId === vehicleId && geometry.data.geometryVersion === geometryVersion) return
    let active = true
    void api.currentPosition(vehicleId).then((result) => { if (active) setGeometry({ vehicleId, data: result }) }).catch(() => undefined)
    return () => { active = false }
  }, [geometry?.data.geometryVersion, geometry?.vehicleId, summary.data?.geometryVersion, vehicleId])

  // Parsed once per geometry: the 10 s position polls keep the same route arrays, so the map does not redraw the whole
  // route each time a driving truck moves.
  const route = useMemo(() => geometry ? {
    routeGeometry: geometryToCoordinates(geometry.data.routeGeometry), routeBreaks: geometry.data.routeBreaks ?? [],
    trafficSegments: geometry.data.trafficSegments ?? [], roadSegments: geometry.data.roadSegments ?? [], trafficCheckedAt: geometry.data.trafficCheckedAt ?? null
  } : null, [geometry])

  const data = useMemo(() => {
    if (!summary.data) return null
    // While a newer geometry loads, keep drawing the previous line of the same leg instead of an empty map.
    if (!geometry || !route || geometry.vehicleId !== vehicleId || !summary.data.geometryVersion || geometry.data.legId !== summary.data.legId) return summary.data
    return { ...summary.data, ...route, ...splitRouteAtCoordinate(route.routeGeometry, summary.data.coordinate) }
  }, [geometry, route, summary.data, vehicleId])

  return { ...summary, data }
}
