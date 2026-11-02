import 'maplibre-gl/dist/maplibre-gl.css'
import { GeoJSONSource, Map, Marker, NavigationControl, setWorkerUrl, type StyleSpecification } from 'maplibre-gl'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { LocateFixed, Route, Satellite, TrafficCone } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { boundsFor, geometryToCoordinates, stopCoordinates, toLineString, trafficFeatures } from '../lib/geometry'
import { calculatedPositionLabel } from '../lib/format'
import type { MapRouteAlternative, MapRouteStop } from '../lib/route-preview'
import type { Coordinate, CurrentPosition, TrafficSegment, Tour } from '../types/domain'

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
// Raster tiles look empty at street level; automatic fits never zoom closer than this.
const FIT_MAX_ZOOM = 13
const MIN_RESTORED_ZOOM = 4
const MAX_RESTORED_ZOOM = 12
type MapMode = 'traffic' | 'satellite'

export type MapPanelProps = {
  tour?: Tour | null
  position?: CurrentPosition | null
  vehicleNumber?: string | null
  focusCoordinate?: Coordinate | null
  previewRoute?: Coordinate[]
  previewStops?: MapRouteStop[]
  previewTraffic?: TrafficSegment[]
  previewAlternatives?: MapRouteAlternative[]
  onSelectPreviewAlternative?: (id: string) => void
  previewKey?: string
  height?: number | string
  fill?: boolean
}

export function MapPanel({
  tour,
  position,
  vehicleNumber,
  focusCoordinate,
  previewRoute,
  previewStops,
  previewTraffic,
  previewAlternatives,
  onSelectPreviewAlternative,
  previewKey,
  height = 520,
  fill = false
}: MapPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const stopMarkersRef = useRef<Marker[]>([])
  const previewMarkersRef = useRef<Marker[]>([])
  const alternativeMarkersRef = useRef<Marker[]>([])
  const onSelectAlternativeRef = useRef(onSelectPreviewAlternative)
  onSelectAlternativeRef.current = onSelectPreviewAlternative
  // isStyleLoaded() is false while tiles load, so track the style lifecycle ourselves.
  const styleReadyRef = useRef(false)
  const [styleVersion, setStyleVersion] = useState(0)
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
    // Grey route variants: a wide invisible line makes them easy to hit with a finger.
    mapRef.current.on('click', 'preview-alt-hit', (event) => {
      const id = event.features?.[0]?.properties?.id
      if (typeof id === 'string') onSelectAlternativeRef.current?.(id)
    })
    mapRef.current.on('mouseenter', 'preview-alt-hit', () => { if (mapRef.current) mapRef.current.getCanvas().style.cursor = 'pointer' })
    mapRef.current.on('mouseleave', 'preview-alt-hit', () => { if (mapRef.current) mapRef.current.getCanvas().style.cursor = '' })
    mapRef.current.on('style.load', () => {
      styleReadyRef.current = true
      setStyleVersion((value) => value + 1)
    })
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
      previewMarkersRef.current.forEach((marker) => marker.remove())
      alternativeMarkersRef.current.forEach((marker) => marker.remove())
      mapRef.current?.remove()
      mapRef.current = null
      markerRef.current = null
      stopMarkersRef.current = []
      previewMarkersRef.current = []
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
    const restore = () => map.jumpTo(camera)
    styleReadyRef.current = false
    map.once('style.load', restore)
    // A full reload, not a diff: a diff silently drops our runtime route layers.
    map.setStyle(styleFor(mode), { diff: false })
    return () => { map.off('style.load', restore) }
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

    if (!styleReadyRef.current) return
    const render = () => {
      renderMapContent(map, fullRoute, position, previewRoute, previewTraffic, previewAlternatives)
      stopMarkersRef.current.forEach((marker) => marker.remove())
      // Same stages as the route drawer: finished stops green, the current one blue and larger.
      const currentId = stops.slice().sort((a, b) => a.sequence - b.sequence).find((stop) => !stop.completedAt)?.id
      stopMarkersRef.current = stops.map((stop) => {
        const element = document.createElement('div')
        const state = stop.completedAt ? 'done' : stop.id === currentId ? 'current' : 'upcoming'
        element.className = `stop-marker stop-marker-${state}`
        element.textContent = state === 'done' ? '✓' : `${stop.sequence}`
        element.setAttribute('aria-label', `Точка ${stop.sequence}${state === 'done' ? ', пройдена' : state === 'current' ? ', текущая' : ''}`)
        return new Marker({ element }).setLngLat([stop.longitude, stop.latitude]).addTo(map)
      })

      const fitKey = tour?.id ?? (stops.length ? `stops:${stops.map((stop) => stop.id).join(':')}` : null)
      // Only remember the fit when it actually happened, so closing a draft still fits the selected tour.
      if (fitKey && fittedTourRef.current !== fitKey && !previewRoute?.length) {
        fittedTourRef.current = fitKey
        const points = [...(position?.coordinate ? [position.coordinate] : []), ...fullRoute, ...stopCoordinates(stops)]
        if (points.length) fitRoute(map, points, FIT_MAX_ZOOM - 1, 0)
      }
    }
    render()
  }, [fullRoute, position, previewRoute, previewTraffic, previewAlternatives, stops, styleVersion, tour?.id])

  useEffect(() => {
    const map = mapRef.current
    previewMarkersRef.current.forEach((marker) => marker.remove())
    previewMarkersRef.current = []
    if (!map || !previewStops?.length) return
    previewMarkersRef.current = previewStops.map((stop) => {
      const element = document.createElement('div')
      element.className = 'stop-marker preview-stop-marker'
      element.textContent = stop.label
      element.title = stop.title
      element.setAttribute('aria-label', `Точка ${stop.label}: ${stop.title}`)
      return new Marker({ element }).setLngLat(stop.coordinate).addTo(map)
    })
  }, [previewStops])

  // Travel time chip in the middle of every grey variant, like Google Maps; a click picks that variant.
  useEffect(() => {
    const map = mapRef.current
    alternativeMarkersRef.current.forEach((marker) => marker.remove())
    alternativeMarkersRef.current = []
    if (!map || !previewAlternatives?.length) return
    alternativeMarkersRef.current = previewAlternatives.filter((item) => item.geometry.length >= 2).map((item) => {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = 'route-alt-chip'
      element.textContent = item.label
      element.setAttribute('aria-label', `Выбрать вариант маршрута: ${item.label}`)
      element.addEventListener('click', (event) => { event.stopPropagation(); onSelectAlternativeRef.current?.(item.id) })
      return new Marker({ element }).setLngLat(item.geometry[Math.floor(item.geometry.length / 2)]).addTo(map)
    })
  }, [previewAlternatives])

  useEffect(() => {
    const map = mapRef.current
    if (map && focusCoordinate) map.easeTo({ center: focusCoordinate, zoom: Math.max(map.getZoom(), 14), duration: 350 })
  }, [focusCoordinate])

  // Fit once per route search: picking another variant must not move the camera.
  const previewFitKey = previewKey ?? previewRoute
  useEffect(() => {
    const map = mapRef.current
    if (map && previewRoute?.length) fitRoute(map, [...previewRoute, ...(previewAlternatives ?? []).flatMap((item) => item.geometry), ...(previewStops ?? []).map((stop) => stop.coordinate)], FIT_MAX_ZOOM, 350)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFitKey, previewStops])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !cameraRequest) return
    if (cameraRequest === 'vehicle' && position?.coordinate) {
      map.easeTo({ center: position.coordinate, zoom: Math.max(map.getZoom(), 14), duration: 260 })
      setCameraRequest(null)
      return
    }
    fitRoute(map, previewRoute?.length ? previewRoute : [...fullRoute, ...stopCoordinates(stops)], FIT_MAX_ZOOM, 260)
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
    label.textContent = `${vehicleNumber ? `LKW ${vehicleNumber}` : 'LKW'} · ${position?.positionSource === 'WEBFLEET' ? 'GPS' : position?.positionSource === 'MANUAL' ? 'Вручную' : 'Расчёт'}`
    element.append(label)
  }, [position?.coordinate, position?.positionSource, vehicleNumber])

  return (
    <section className={fill ? 'map-panel-fill' : 'map-panel-card work-surface relative min-w-0 overflow-hidden'}>
      <div ref={containerRef} style={{ height }} className={fill ? 'h-full w-full' : 'rounded-lg'} />
      <div className="map-controls" aria-label="Управление картой">
        <button type="button" className="map-mode-switch" onClick={() => setMode((current) => current === 'traffic' ? 'satellite' : 'traffic')} aria-label={mode === 'traffic' ? 'Переключить на спутник' : 'Переключить на карту пробок'} title={mode === 'traffic' ? 'Показать спутник' : 'Показать пробки'}>{mode === 'traffic' ? <Satellite className="h-4 w-4" /> : <TrafficCone className="h-4 w-4" />}<span>{mode === 'traffic' ? 'Спутник' : 'Пробки'}</span></button>
        <button type="button" onClick={() => setCameraRequest('vehicle')} disabled={!position?.coordinate} title="Показать выбранную машину"><LocateFixed className="h-4 w-4" /><span>К машине</span></button>
        <button type="button" onClick={() => setCameraRequest('route')} disabled={!fullRoute.length && !stops.length && !previewRoute?.length} title="Показать весь маршрут"><Route className="h-4 w-4" /><span>Маршрут</span></button>
      </div>
      {!tomTomMapKey() && mode === 'traffic' ? <div className="map-provider-note">OSM · без live-пробок</div> : null}
      <TrafficLegend segments={previewRoute?.length ? previewTraffic : position?.trafficSegments} checkedAt={previewRoute?.length ? null : position?.trafficCheckedAt} />
    </section>
  )
}

// Google-style route: white casing, blue line, congestion on top, travelled part grey.
const ROUTE_BLUE = '#1a73e8'
const PREVIEW_BLUE = '#174ea6'
const ALT_GREY = '#8fa3bf'
const TRAFFIC_COLORS = { SLOW: '#f29900', JAM: '#d93025', STANDSTILL: '#8b0000', CLOSED: '#202124' } as const
const TRAFFIC_LABELS = { SLOW: 'медленно', JAM: 'пробка', STANDSTILL: 'стоит', CLOSED: 'перекрыто' } as const
const LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], 5, 3.5, 10, 6.5, 14, 10] as unknown as number
const CASING_WIDTH = ['interpolate', ['linear'], ['zoom'], 5, 6.5, 10, 10.5, 14, 14] as unknown as number
const TRAFFIC_COLOR = ['match', ['get', 'level'], 'SLOW', TRAFFIC_COLORS.SLOW, 'JAM', TRAFFIC_COLORS.JAM, 'STANDSTILL', TRAFFIC_COLORS.STANDSTILL, 'CLOSED', TRAFFIC_COLORS.CLOSED, ROUTE_BLUE] as unknown as string
const TRAFFIC_FLOW_OPACITY = 0.72
const TRAFFIC_FLOW_OPACITY_WITH_ROUTE = 0.4

function renderMapContent(map: Map, fullRoute: Coordinate[], position?: CurrentPosition | null, previewRoute?: Coordinate[], previewTraffic?: TrafficSegment[], previewAlternatives?: MapRouteAlternative[]) {
  const travelled = geometryToCoordinates(position?.travelledGeometry)
  upsertRouteLayer(map, 'route-casing', toLineString(fullRoute), { 'line-color': '#ffffff', 'line-width': CASING_WIDTH, 'line-opacity': 0.95 })
  upsertRouteLayer(map, 'route-main', toLineString(fullRoute), { 'line-color': ROUTE_BLUE, 'line-width': LINE_WIDTH })
  upsertRouteLayer(map, 'route-traffic', trafficFeatures(fullRoute, position?.trafficSegments), { 'line-color': TRAFFIC_COLOR, 'line-width': LINE_WIDTH })
  upsertRouteLayer(map, 'route-travelled', toLineString(travelled), { 'line-color': '#9aa0a6', 'line-width': LINE_WIDTH })
  const preview = previewRoute ?? []
  const alternatives = { type: 'FeatureCollection' as const, features: (previewAlternatives ?? []).filter((item) => item.geometry.length >= 2)
    .map((item) => ({ type: 'Feature' as const, properties: { id: item.id }, geometry: { type: 'LineString' as const, coordinates: item.geometry } })) }
  upsertRouteLayer(map, 'preview-alt-casing', alternatives, { 'line-color': '#ffffff', 'line-width': CASING_WIDTH, 'line-opacity': 0.9 })
  upsertRouteLayer(map, 'preview-alt', alternatives, { 'line-color': ALT_GREY, 'line-width': LINE_WIDTH })
  upsertRouteLayer(map, 'preview-alt-hit', alternatives, { 'line-color': '#000000', 'line-width': 18, 'line-opacity': 0 })
  upsertRouteLayer(map, 'preview-casing', toLineString(preview), { 'line-color': '#ffffff', 'line-width': CASING_WIDTH, 'line-opacity': 0.95 })
  upsertRouteLayer(map, 'preview-main', toLineString(preview), { 'line-color': PREVIEW_BLUE, 'line-width': LINE_WIDTH })
  upsertRouteLayer(map, 'preview-traffic', trafficFeatures(preview, previewTraffic), { 'line-color': TRAFFIC_COLOR, 'line-width': LINE_WIDTH })
  // The route must stand out: dim the city-wide traffic layer while a route is shown.
  if (map.getLayer('traffic-flow')) {
    map.setPaintProperty('traffic-flow', 'raster-opacity', fullRoute.length > 1 || preview.length > 1 ? TRAFFIC_FLOW_OPACITY_WITH_ROUTE : TRAFFIC_FLOW_OPACITY)
  }
}

function TrafficLegend({ segments, checkedAt }: { segments?: TrafficSegment[] | null; checkedAt?: string | null }) {
  if (!segments?.length) return null
  const levels = (Object.keys(TRAFFIC_COLORS) as Array<keyof typeof TRAFFIC_COLORS>).filter((level) => segments.some((segment) => segment.level === level))
  const checked = checkedAt ? new Date(checkedAt) : null
  const valid = checked && Number.isFinite(checked.getTime()) ? checked : null
  const stale = valid ? Date.now() - valid.getTime() > 30 * 60_000 : false
  return <div className="map-traffic-legend" role="note" aria-label="Пробки на маршруте">
    <strong>Пробки на маршруте</strong>
    {levels.map((level) => <span key={level}><i style={{ background: TRAFFIC_COLORS[level] }} aria-hidden="true" />{TRAFFIC_LABELS[level]}</span>)}
    {valid ? <small className={stale ? 'map-traffic-legend-stale' : undefined}>{stale ? 'данные устарели · ' : 'данные '}{valid.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</small> : null}
  </div>
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
    const center: Coordinate = [Number(parsed.center[0]), Number(parsed.center[1])]
    if (!center.every(Number.isFinite) || Math.abs(center[0]) > 180 || Math.abs(center[1]) > 90 || !Number.isFinite(parsed.zoom)) return null
    return { center, zoom: Math.min(MAX_RESTORED_ZOOM, Math.max(MIN_RESTORED_ZOOM, parsed.zoom)) }
  } catch {
    return null
  }
}

function readMapMode(): MapMode {
  return window.localStorage.getItem('ops-dashboard-map-mode') === 'satellite' ? 'satellite' : 'traffic'
}

function markerDescription(vehicleNumber?: string | null, source?: CurrentPosition['positionSource']): string {
  return `${vehicleNumber ? `LKW ${vehicleNumber}` : 'Грузовик'} · ${source === 'WEBFLEET' ? 'фактическая позиция Webfleet GPS' : source === 'MANUAL' ? 'позиция, указанная диспетчером вручную' : calculatedPositionLabel}`
}

function upsertRouteLayer(map: Map, id: string, data: GeoJSON.Feature | GeoJSON.FeatureCollection, paint: Record<string, unknown>) {
  const sourceId = `${id}-source`
  const source = map.getSource(sourceId) as GeoJSONSource | undefined
  if (source) {
    source.setData(data)
    return
  }
  map.addSource(sourceId, { type: 'geojson', data })
  map.addLayer({ id, type: 'line', source: sourceId, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint } as Parameters<Map['addLayer']>[0])
}
