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

  const data = useMemo(() => {
    if (!summary.data) return null
    if (!geometry || geometry.vehicleId !== vehicleId || geometry.data.geometryVersion !== summary.data.geometryVersion) return summary.data
    const routeGeometry = geometryToCoordinates(geometry.data.routeGeometry)
    const split = splitRouteAtCoordinate(routeGeometry, summary.data.coordinate)
    return { ...summary.data, routeGeometry, ...split }
  }, [geometry, summary.data, vehicleId])

  return { ...summary, data }
}
