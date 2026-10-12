import { GeoJSONSource, Map, Marker, NavigationControl, setWorkerUrl, type StyleSpecification } from 'maplibre-gl'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { useEffect, useMemo, useRef } from 'react'

import { boundsFor, geometryToCoordinates, stopCoordinates, toLineString } from '../lib/geometry'
import { calculatedPositionLabel } from '../lib/format'
import type { Coordinate, CurrentPosition, Tour } from '../types/domain'

setWorkerUrl(mapLibreWorkerUrl)

const osmStyle: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [import.meta.env.VITE_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: import.meta.env.VITE_MAP_ATTRIBUTION || '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    }
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
}

export function MapPanel({
  tour,
  position,
  height = 520
}: {
  tour?: Tour | null
  position?: CurrentPosition | null
  height?: number
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const stopMarkersRef = useRef<Marker[]>([])

  const stops = useMemo(() => tour?.stops?.slice().sort((a, b) => a.sequence - b.sequence) ?? [], [tour?.stops])
  const legs = useMemo(() => tour?.legs ?? [], [tour?.legs])
  const fullRoute = useMemo(() => {
    const fromPosition = geometryToCoordinates(position?.routeGeometry)
    if (fromPosition.length) return fromPosition
    return legs.flatMap((leg) => geometryToCoordinates(leg.routeGeometry))
  }, [legs, position?.routeGeometry])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    mapRef.current = new Map({
      container: containerRef.current,
      style: osmStyle,
      center: [10.4515, 51.1657],
      zoom: 5.2
    })
    mapRef.current.addControl(new NavigationControl({ visualizePitch: false }), 'top-right')

    return () => {
      markerRef.current?.remove()
      stopMarkersRef.current.forEach((marker) => marker.remove())
      mapRef.current?.remove()
      mapRef.current = null
      markerRef.current = null
      stopMarkersRef.current = []
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const render = () => {
      upsertLine(map, 'route-full', fullRoute, '#64748b', 4, 0.45)
      upsertLine(map, 'route-travelled', geometryToCoordinates(position?.travelledGeometry), '#059669', 5, 0.95)
      upsertLine(map, 'route-remaining', geometryToCoordinates(position?.remainingGeometry), '#2563eb', 5, 0.9)
      stopMarkersRef.current.forEach((marker) => marker.remove())
      stopMarkersRef.current = stops.map((stop) => {
        const element = document.createElement('div')
        element.className = 'stop-marker'
        element.textContent = `${stop.sequence}`
        element.setAttribute('aria-label', `Точка ${stop.sequence}`)
        return new Marker({ element }).setLngLat([stop.longitude, stop.latitude]).addTo(map)
      })

      const coordinates = [...fullRoute, ...stopCoordinates(stops)]
      const bounds = boundsFor(coordinates)
      if (bounds) {
        map.fitBounds([bounds[0], bounds[1]], { padding: 64, maxZoom: 11, duration: 0 })
      }
    }

    if (map.isStyleLoaded()) render()
    else map.once('load', render)
    return () => { map.off('load', render) }
  }, [fullRoute, position?.remainingGeometry, position?.travelledGeometry, stops])

  useEffect(() => {
    const map = mapRef.current
    const coordinate = position?.coordinate
    if (!map || !coordinate) {
      markerRef.current?.remove()
      markerRef.current = null
      return
    }

    if (!markerRef.current) {
      const element = document.createElement('div')
      element.className = 'truck-marker'
      element.setAttribute('aria-label', calculatedPositionLabel)
      markerRef.current = new Marker({ element }).setLngLat(coordinate).addTo(map)
    } else {
      markerRef.current.setLngLat(coordinate)
    }
  }, [position?.coordinate])

  return (
    <section className="work-surface min-w-0 overflow-hidden">
      <div ref={containerRef} style={{ height }} className="rounded-t-lg" />
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm">
        <span className="font-semibold text-amber-900">{calculatedPositionLabel}</span>
        <span className="min-w-0 text-balance-safe text-slate-500">OpenStreetMap · дороги, трафик и актуальность данных показаны в разделе «Время грузовика»</span>
      </div>
    </section>
  )
}

function upsertLine(
  map: Map,
  id: string,
  coordinates: Coordinate[],
  color: string,
  width: number,
  opacity: number
) {
  const sourceId = `${id}-source`
  const data = toLineString(coordinates)
  const source = map.getSource(sourceId) as GeoJSONSource | undefined

  if (source) {
    source.setData(data)
  } else {
    map.addSource(sourceId, { type: 'geojson', data })
    map.addLayer({
      id,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': color,
        'line-width': width,
        'line-opacity': opacity
      }
    })
  }
}
