import { GeoJSONSource, Map, Marker, NavigationControl, setWorkerUrl, type StyleSpecification } from 'maplibre-gl'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { LocateFixed, Route, Satellite, TrafficCone } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

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

const fallbackSatelliteStyle: StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Tiles © Esri'
    }
  },
  layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }]
}

const CAMERA_STORAGE_KEY = 'ops-dashboard-map-camera'
type MapMode = 'traffic' | 'satellite'

export function MapPanel({
  tour,
  position,
  vehicleNumber,
  focusCoordinate,
  previewRoute,
  height = 520,
  fill = false
}: {
  tour?: Tour | null
  position?: CurrentPosition | null
  vehicleNumber?: string | null
  focusCoordinate?: Coordinate | null
  previewRoute?: Coordinate[]
  height?: number | string
  fill?: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const stopMarkersRef = useRef<Marker[]>([])
  const fittedTourRef = useRef<string | null>(null)
  const [mode, setMode] = useState<MapMode>(() => readMapMode())
  const [cameraRequest, setCameraRequest] = useState<'vehicle' | 'route' | null>(null)
  const initialModeRef = useRef(mode)
  const modeEffectReadyRef = useRef(false)

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
      style: styleFor(initialModeRef.current),
      center: readCamera()?.center ?? [10.4515, 51.1657],
      zoom: readCamera()?.zoom ?? 5.2
    })
    mapRef.current.addControl(new NavigationControl({ visualizePitch: false }), 'top-left')
    mapRef.current.on('moveend', () => {
      const map = mapRef.current
      if (!map) return
      const center = map.getCenter()
      window.localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify({
        center: [center.lng, center.lat],
        zoom: map.getZoom()
      }))
    })

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
    window.localStorage.setItem('ops-dashboard-map-mode', mode)
    if (!modeEffectReadyRef.current) {
      modeEffectReadyRef.current = true
      return
    }
    const map = mapRef.current
    if (!map) return
    const center = map.getCenter()
    const camera = { center: [center.lng, center.lat] as Coordinate, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }
    const restoreAndRender = () => {
      map.jumpTo(camera)
    }
    map.once('style.load', restoreAndRender)
    map.setStyle(styleFor(mode))
    return () => { map.off('style.load', restoreAndRender) }
  }, [mode])

  useEffect(() => {
    const container = containerRef.current
    const map = mapRef.current
    if (!container || !map || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const render = () => {
      renderMapContent(map, fullRoute, position, previewRoute)
      stopMarkersRef.current.forEach((marker) => marker.remove())
      stopMarkersRef.current = stops.map((stop) => {
        const element = document.createElement('div')
        element.className = 'stop-marker'
        element.textContent = `${stop.sequence}`
        element.setAttribute('aria-label', `Точка ${stop.sequence}`)
        return new Marker({ element }).setLngLat([stop.longitude, stop.latitude]).addTo(map)
      })

      const fitKey = tour?.id ?? (stops.length ? `stops:${stops.map((stop) => stop.id).join(':')}` : null)
      if (fitKey && fittedTourRef.current !== fitKey) {
        fittedTourRef.current = fitKey
        if (!previewRoute?.length) {
          if (position?.coordinate) map.jumpTo({ center: position.coordinate, zoom: 15.5 })
          else fitRoute(map, [...fullRoute, ...stopCoordinates(stops)], 15.5, 0)
        }
      }
    }

    if (map.isStyleLoaded()) render()
    else map.once('style.load', render)
    return () => { map.off('style.load', render) }
  }, [fullRoute, mode, position, previewRoute, stops, tour?.id])

  useEffect(() => {
    const map = mapRef.current
    if (map && focusCoordinate) map.easeTo({ center: focusCoordinate, zoom: Math.max(map.getZoom(), 15), duration: 350 })
  }, [focusCoordinate])

  useEffect(() => {
    const map = mapRef.current
    if (map && previewRoute?.length) fitRoute(map, previewRoute, 14, 350)
  }, [previewRoute])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !cameraRequest) return
    if (cameraRequest === 'vehicle' && position?.coordinate) {
      map.easeTo({ center: position.coordinate, zoom: Math.max(map.getZoom(), 15.5), duration: 260 })
      setCameraRequest(null)
      return
    }
    fitRoute(map, previewRoute?.length ? previewRoute : [...fullRoute, ...stopCoordinates(stops)], 15.5, 260)
    setCameraRequest(null)
  }, [cameraRequest, fullRoute, position?.coordinate, previewRoute, stops])

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
      element.setAttribute('aria-label', markerDescription(vehicleNumber, position?.positionSource))
      markerRef.current = new Marker({ element }).setLngLat(coordinate).addTo(map)
    } else {
      markerRef.current.setLngLat(coordinate)
    }
    const element = markerRef.current.getElement()
    element.setAttribute('aria-label', markerDescription(vehicleNumber, position?.positionSource))
    element.innerHTML = ''
    const label = document.createElement('span')
    label.className = 'truck-marker-label'
    label.textContent = `${vehicleNumber ? `LKW ${vehicleNumber}` : 'LKW'} · ${position?.positionSource === 'WEBFLEET' ? 'GPS' : 'Расчёт'}`
    element.append(label)
  }, [position?.coordinate, position?.positionSource, vehicleNumber])

  return (
    <section className={fill ? 'map-panel-fill' : 'work-surface min-w-0 overflow-hidden'}>
      <div ref={containerRef} style={{ height }} className={fill ? 'h-full w-full' : 'rounded-lg'} />
      <div className="map-controls" aria-label="Управление картой">
        <button type="button" className="map-mode-switch" onClick={() => setMode((current) => current === 'traffic' ? 'satellite' : 'traffic')} aria-label={mode === 'traffic' ? 'Переключить на спутник' : 'Переключить на карту пробок'} title={mode === 'traffic' ? 'Показать спутник' : 'Показать пробки'}>{mode === 'traffic' ? <Satellite className="h-4 w-4" /> : <TrafficCone className="h-4 w-4" />}<span>{mode === 'traffic' ? 'Спутник' : 'Пробки'}</span></button>
        <button type="button" onClick={() => setCameraRequest('vehicle')} disabled={!position?.coordinate} title="Показать выбранную машину"><LocateFixed className="h-4 w-4" /><span>К машине</span></button>
        <button type="button" onClick={() => setCameraRequest('route')} disabled={!fullRoute.length && !stops.length} title="Показать весь маршрут"><Route className="h-4 w-4" /><span>Маршрут</span></button>
      </div>
      {!tomTomMapKey() && mode === 'traffic' ? <div className="map-provider-note">OSM · без live-пробок</div> : null}
    </section>
  )
}

function renderMapContent(map: Map, fullRoute: Coordinate[], position?: CurrentPosition | null, previewRoute?: Coordinate[]) {
  if (!map.isStyleLoaded()) return
  upsertLine(map, 'route-full', fullRoute, '#64748b', 4, 0.45)
  upsertLine(map, 'route-travelled', geometryToCoordinates(position?.travelledGeometry), '#059669', 5, 0.95)
  upsertLine(map, 'route-remaining', geometryToCoordinates(position?.remainingGeometry), '#2563eb', 5, 0.9)
  upsertLine(map, 'route-preview', previewRoute ?? [], '#d97706', 5, 0.85)
}

function styleFor(mode: MapMode): StyleSpecification {
  const key = tomTomMapKey()
  if (!key) return mode === 'satellite' ? fallbackSatelliteStyle : osmStyle
  const baseTile = mode === 'satellite'
    ? `https://api.tomtom.com/map/1/tile/sat/main/{z}/{x}/{y}.jpg?key=${key}`
    : `https://api.tomtom.com/map/1/tile/basic/main/{z}/{x}/{y}.png?key=${key}`
  const sources: StyleSpecification['sources'] = {
    base: { type: 'raster', tiles: [baseTile], tileSize: 256, attribution: '© TomTom, © OpenStreetMap contributors' }
  }
  const layers: StyleSpecification['layers'] = [{ id: 'base', type: 'raster', source: 'base' }]
  if (mode === 'traffic') {
    sources.traffic = {
      type: 'raster',
      tiles: [`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${key}`],
      tileSize: 256
    }
    layers.push({ id: 'traffic-flow', type: 'raster', source: 'traffic', paint: { 'raster-opacity': 0.72 } })
  }
  return { version: 8, sources, layers }
}

function tomTomMapKey(): string | undefined {
  return (import.meta.env.VITE_TOMTOM_MAPS_KEY || import.meta.env.VITE_TOMTOM_MAP_KEY) as string | undefined
}

function fitRoute(map: Map | null, coordinates: Coordinate[], maxZoom: number, duration: number) {
  if (!map) return
  const bounds = boundsFor(coordinates)
  if (bounds) {
    map.fitBounds([bounds[0], bounds[1]], { padding: 64, maxZoom, duration })
  }
}

function readCamera(): { center: Coordinate; zoom: number } | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CAMERA_STORAGE_KEY) ?? 'null') as { center?: unknown; zoom?: unknown } | null
    if (!parsed || !Array.isArray(parsed.center) || parsed.center.length !== 2 || typeof parsed.zoom !== 'number') return null
    return { center: [Number(parsed.center[0]), Number(parsed.center[1])], zoom: parsed.zoom }
  } catch {
    return null
  }
}

function readMapMode(): MapMode {
  return window.localStorage.getItem('ops-dashboard-map-mode') === 'satellite' ? 'satellite' : 'traffic'
}

function markerDescription(vehicleNumber?: string | null, source?: CurrentPosition['positionSource']): string {
  return `${vehicleNumber ? `LKW ${vehicleNumber}` : 'Грузовик'} · ${source === 'WEBFLEET' ? 'фактическая позиция Webfleet GPS' : calculatedPositionLabel}`
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
