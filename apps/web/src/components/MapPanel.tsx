import 'maplibre-gl/dist/maplibre-gl.css'
import { GeoJSONSource, LngLatBounds, Map, Marker, Popup, setWorkerUrl, type StyleSpecification, type VectorTileSource } from 'maplibre-gl'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Gauge, Layers, LocateFixed, Minus, Plus, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { boundsFor, geometryToCoordinates, stopCoordinates, toBrokenLine, toLineString, trafficFeatures } from '../lib/geometry'
import { calculatedPositionLabel } from '../lib/format'
import { useStableValue } from '../hooks/useStableValue'
import { formatDelay, formatKm, INCIDENT_TITLES, trafficIncidents, type TrafficIncident } from '../lib/traffic-incidents'
import { gestureFps, mapPixelRatio, readLiteChoice, rendererKind, rendererLabel, SLOW_GESTURES_FOR_LITE, slowStreak, type LiteChoice } from '../lib/map-quality'
import { TRAFFIC_COLORS, TRAFFIC_MAX_TILE_ZOOM, TRAFFIC_REFRESH_MS, trafficFlowLayer, trafficTileUrl } from '../lib/traffic-flow'
import type { MapRouteAlternative, MapRouteStop } from '../lib/route-preview'
import { roadShieldLabel, roadShields, visibleShields } from '../lib/road-shields'
import { THEME_EVENT, currentTheme, type Theme } from '../lib/theme'
import type { Coordinate, CurrentPosition, RoadSegment, TrafficSegment, Tour } from '../types/domain'

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
  layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-fade-duration': 0 } }]
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
  layers: [{ id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-fade-duration': 0 } }]
}

const CAMERA_STORAGE_KEY = 'ops-dashboard-map-camera'
const LITE_STORAGE_KEY = 'ops-dashboard-map-lite'
// Raster tiles look empty at street level; automatic fits never zoom closer than this.
const FIT_MAX_ZOOM = 13
const MIN_RESTORED_ZOOM = 4
const MAX_RESTORED_ZOOM = 12
type MapMode = 'map' | 'satellite'
/** Status colour of a truck on the map and in the list. */
export type FleetTone = 'ok' | 'stop' | 'late' | 'plan' | 'idle'

/** One truck of the fleet layer; the selected truck is drawn by the main marker instead. */
export type FleetMapVehicle = {
  id: string
  label: string
  coordinate: Coordinate
  source: 'WEBFLEET' | 'CALCULATED' | 'MANUAL'
  stale: boolean | null
  courseDeg: number | null
  standstill: boolean | null
  /** The truck's next stop has an attached slot (Termin). */
  termin?: boolean
  tone?: FleetTone
}

const FLEET_LABEL_MIN_ZOOM = 7

export type MapPanelProps = {
  /** Today's GPS track of the truck in the open card. */
  track?: Coordinate[] | null
  fleet?: FleetMapVehicle[]
  selectedVehicleId?: string | null
  onSelectFleetVehicle?: (vehicleId: string) => void
  tour?: Tour | null
  position?: CurrentPosition | null
  vehicleNumber?: string | null
  focusCoordinate?: Coordinate | null
  previewRoute?: Coordinate[]
  previewStops?: MapRouteStop[]
  previewTraffic?: TrafficSegment[]
  previewRoads?: RoadSegment[]
  previewAlternatives?: MapRouteAlternative[]
  onSelectPreviewAlternative?: (id: string) => void
  previewKey?: string
  height?: number | string
  fill?: boolean
  /** A new value fits the camera to the selected truck's route. */
  fitRouteRequest?: number
  /** "TomTom · пробки …" in the corner; only the dashboard shows it. */
  sourceNote?: boolean
}

export function MapPanel({
  track: trackProp,
  fleet: fleetProp,
  selectedVehicleId,
  onSelectFleetVehicle,
  tour,
  position: positionProp,
  vehicleNumber,
  focusCoordinate,
  previewRoute: previewRouteProp,
  previewStops: previewStopsProp,
  previewTraffic: previewTrafficProp,
  previewRoads: previewRoadsProp,
  previewAlternatives: previewAlternativesProp,
  onSelectPreviewAlternative,
  previewKey,
  height = 520,
  fill = false,
  fitRouteRequest = 0,
  sourceNote = false
}: MapPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const stopMarkersRef = useRef<Marker[]>([])
  const previewMarkersRef = useRef<Marker[]>([])
  const alternativeMarkersRef = useRef<Marker[]>([])
  const trafficMarkersRef = useRef<globalThis.Map<string, Marker>>(new globalThis.Map())
  const trafficPopupRef = useRef<{ id: string; popup: Popup } | null>(null)
  const shieldMarkersRef = useRef<globalThis.Map<string, Marker>>(new globalThis.Map())
  const declutterShieldsRef = useRef<() => void>(() => undefined)
  const onSelectAlternativeRef = useRef(onSelectPreviewAlternative)
  onSelectAlternativeRef.current = onSelectPreviewAlternative
  const fleetMarkersRef = useRef<globalThis.Map<string, Marker>>(new globalThis.Map())
  const onSelectFleetRef = useRef(onSelectFleetVehicle)
  onSelectFleetRef.current = onSelectFleetVehicle
  const selectedIdRef = useRef(selectedVehicleId)
  selectedIdRef.current = selectedVehicleId
  // isStyleLoaded() is false while tiles load, so track the style lifecycle ourselves.
  const styleReadyRef = useRef(false)
  const [styleVersion, setStyleVersion] = useState(0)
  const fittedTourRef = useRef<string | null>(null)
  const [mode, setMode] = useState<MapMode>(() => readMapMode())
  const [traffic, setTraffic] = useState(() => readTraffic())
  const [labels, setLabels] = useState(() => readLabels())
  // «Лёгкий режим»: fewer pixels to draw. On by the dispatcher's choice, or by itself once panning and zooming prove slow.
  const [liteChoice, setLiteChoice] = useState<LiteChoice>(() => readLiteChoice(readStored(LITE_STORAGE_KEY)))
  const [autoLite, setAutoLite] = useState(false)
  const lite = liteChoice === 'on' || (liteChoice === 'auto' && autoLite)
  const initialLiteRef = useRef(lite)
  const [diagnostics, setDiagnostics] = useState<MapDiagnostics | null>(null)
  const gestureRef = useRef<{ frames: number[]; fps: number | null; slow: number }>({ frames: [], fps: null, slow: 0 })
  const [cameraRequest, setCameraRequest] = useState<'vehicle' | 'route' | null>(null)
  const initialModeRef = useRef(mode)
  const initialTrafficRef = useRef(traffic)
  const clusterMarkersRef = useRef<Marker[]>([])
  // On the dashboard the controls sit on top and the selected-truck panel at the bottom: keep routes clear of both.
  const fillRef = useRef(fill)
  const reclusterRef = useRef<() => void>(() => undefined)
  const [theme, setThemeState] = useState<Theme>(() => currentTheme())
  const initialThemeRef = useRef(theme)
  const modeEffectReadyRef = useRef(false)

  const position = useStableValue(positionProp)
  const fleet = useStableValue(fleetProp)
  const track = useStableValue(trackProp)
  const previewRoute = useStableValue(previewRouteProp)
  const previewStops = useStableValue(previewStopsProp)
  const previewTraffic = useStableValue(previewTrafficProp)
  const previewRoads = useStableValue(previewRoadsProp)
  const previewAlternatives = useStableValue(previewAlternativesProp)
  const tourStops = useStableValue(tour?.stops)
  const tourLegs = useStableValue(tour?.legs)
  const stops = useMemo(() => tourStops?.slice().sort((a, b) => a.sequence - b.sequence) ?? [], [tourStops])
  const legs = useMemo(() => tourLegs ?? [], [tourLegs])
  const fullRoute = useMemo(() => {
    const fromPosition = geometryToCoordinates(position?.routeGeometry)
    if (fromPosition.length) return fromPosition
    return legs.flatMap((leg) => geometryToCoordinates(leg.routeGeometry))
  }, [legs, position?.routeGeometry])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const trafficMarkers = trafficMarkersRef.current
    const shieldMarkers = shieldMarkersRef.current
    const fleetMarkers = fleetMarkersRef.current
    const clusterMarkers = clusterMarkersRef

    mapRef.current = new Map({
      container: containerRef.current,
      style: styleFor(initialModeRef.current, initialTrafficRef.current, initialThemeRef.current),
      center: readCamera()?.center ?? [10.4515, 51.1657],
      zoom: readCamera()?.zoom ?? 5.2,
      // TomTom traffic tiles expire within about a minute; reloading and re-reading every visible tile each time made the
      // map stutter (owner, 12.11.2026). Traffic is refreshed on our own schedule instead (TRAFFIC_REFRESH_MS).
      refreshExpiredTiles: false,
      pixelRatio: mapPixelRatio(initialLiteRef.current, window.devicePixelRatio)
    })
    // How smooth each pan and zoom really is on this computer: shown in the diagnostics, and two slow ones in a row switch
    // the light mode on.
    mapRef.current.on('movestart', () => { gestureRef.current.frames = [] })
    mapRef.current.on('render', () => { if (mapRef.current?.isMoving()) gestureRef.current.frames.push(performance.now()) })
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
    // Fleet numbers only from regional zoom on; at country level they would cover each other.
    const updateFleetLabels = () => containerRef.current?.classList.toggle('fleet-labels-hidden', (mapRef.current?.getZoom() ?? 0) < FLEET_LABEL_MIN_ZOOM)
    mapRef.current.on('zoom', updateFleetLabels)
    updateFleetLabels()
    // While zooming, traffic waits for the final zoom: otherwise the TomTom tiles of every zoom level passed are fetched and
    // read on the way, which made zooming stutter (owner, 12.11.2026).
    mapRef.current.on('zoomstart', () => setTrafficVisible(mapRef.current, false))
    mapRef.current.on('zoomend', () => setTrafficVisible(mapRef.current, true))
    mapRef.current.on('moveend', () => {
      const map = mapRef.current
      if (!map) return
      reclusterRef.current()
      declutterShieldsRef.current()
      const gesture = gestureRef.current
      const fps = gestureFps(gesture.frames)
      if (fps !== null) gesture.fps = fps
      gesture.slow = slowStreak(gesture.slow, fps)
      if (gesture.slow >= SLOW_GESTURES_FOR_LITE) setAutoLite(true)
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
      trafficPopupRef.current?.popup.remove()
      trafficMarkers.forEach((marker) => marker.remove())
      trafficMarkers.clear()
      shieldMarkers.forEach((marker) => marker.remove())
      shieldMarkers.clear()
      fleetMarkers.forEach((marker) => marker.remove())
      fleetMarkers.clear()
      clusterMarkers.current.forEach((marker) => marker.remove())
      mapRef.current?.remove()
      mapRef.current = null
      markerRef.current = null
      stopMarkersRef.current = []
      previewMarkersRef.current = []
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem('ops-dashboard-map-mode', mode)
      window.localStorage.setItem('ops-dashboard-map-traffic', traffic ? '1' : '0')
    } catch { /* convenience only */ }
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
    map.setStyle(styleFor(mode, traffic, theme), { diff: false })
    return () => { map.off('style.load', restore) }
  }, [mode, theme, traffic])

  useEffect(() => {
    try { window.localStorage.setItem('ops-dashboard-map-labels', labels ? '1' : '0') } catch { /* convenience only */ }
  }, [labels])

  // Fresh traffic every few minutes, never in the middle of a pan or zoom and not while the tab is hidden.
  useEffect(() => {
    const map = mapRef.current
    const key = tomTomMapKey()
    if (!map || !traffic || !key) return
    const refresh = () => {
      const source = map.getSource('traffic') as VectorTileSource | undefined
      if (!source || document.hidden) return
      const apply = () => source.setTiles([trafficTileUrl(key)])
      if (map.isMoving()) map.once('idle', apply)
      else apply()
    }
    const timer = window.setInterval(refresh, TRAFFIC_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [traffic])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const ratio = mapPixelRatio(lite, window.devicePixelRatio)
    if (map.getPixelRatio() !== ratio) map.setPixelRatio(ratio)
    gestureRef.current.slow = 0
  }, [lite])

  const chooseLite = (on: boolean) => {
    setLiteChoice(on ? 'on' : 'off')
    try { window.localStorage.setItem(LITE_STORAGE_KEY, on ? 'on' : 'off') } catch { /* convenience only */ }
  }
  const toggleDiagnostics = () => setDiagnostics((open) => open ? null : readDiagnostics(mapRef.current, gestureRef.current.fps))

  useEffect(() => {
    if (fitRouteRequest) setCameraRequest('route')
  }, [fitRouteRequest])

  useEffect(() => {
    const onTheme = (event: Event) => setThemeState((event as CustomEvent<Theme>).detail)
    window.addEventListener(THEME_EVENT, onTheme)
    return () => window.removeEventListener(THEME_EVENT, onTheme)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    const map = mapRef.current
    if (!container || !map || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // A driving truck only moves the grey travelled part: the route lines are sent to the map again only when they change.
  const routeBreaks = useStableValue(position?.routeBreaks ?? null)
  const routeTraffic = position?.trafficSegments
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReadyRef.current) return
    renderRouteLayers(map, fullRoute, routeBreaks, routeTraffic, previewRoute, previewTraffic, previewAlternatives)
  }, [fullRoute, routeBreaks, routeTraffic, previewRoute, previewTraffic, previewAlternatives, styleVersion])

  const travelledGeometry = position?.travelledGeometry
  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReadyRef.current) return
    upsertRouteLayer(map, 'route-travelled', toBrokenLine(geometryToCoordinates(travelledGeometry), routeBreaks), { 'line-color': '#9aa0a6', 'line-width': LINE_WIDTH },
      map.getLayer('preview-alt-casing') ? 'preview-alt-casing' : undefined)
  }, [travelledGeometry, routeBreaks, styleVersion])

  const positionRef = useRef(position)
  positionRef.current = position
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (!styleReadyRef.current) return
    const render = () => {
      const position = positionRef.current
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
        if (points.length) fitRoute(map, points, FIT_MAX_ZOOM - 1, 0, fitPadding(containerRef.current, fillRef.current))
      }
    }
    render()
  }, [fullRoute, previewRoute, stops, styleVersion, tour?.id])

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

  // Jams on the route get a small icon; a click shows what the jam costs. The truck's own route counts from
  // where the truck is now, a preview from its start.
  const travelledIndex = useMemo(() => Math.max(0, geometryToCoordinates(travelledGeometry).length - 1), [travelledGeometry])
  const incidents = useMemo(() => previewRoute?.length
    ? trafficIncidents(previewRoute, previewTraffic)
    : trafficIncidents(fullRoute, routeTraffic, { startIndex: travelledIndex }),
  [fullRoute, routeTraffic, travelledIndex, previewRoute, previewTraffic])
  const incidentsCheckedAt = previewRoute?.length ? null : position?.trafficCheckedAt ?? null
  const incidentFromTruck = !previewRoute?.length

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const markers = trafficMarkersRef.current
    const wanted = new Set(incidents.map((incident) => incident.id))
    for (const [id, marker] of markers) {
      if (!wanted.has(id)) { marker.remove(); markers.delete(id) }
    }
    const openPopup = (incident: TrafficIncident, button: HTMLElement, fromKeyboard: boolean) => {
      trafficPopupRef.current?.popup.remove()
      // Focus moves into the window only for keyboard users; a mouse click leaves no focus ring.
      const popup = new Popup({ offset: 16, closeButton: true, closeOnClick: true, focusAfterOpen: fromKeyboard, maxWidth: '260px', className: 'traffic-incident-popup' })
        .setLngLat(incident.coordinate)
        .setDOMContent(incidentDetails(incident, incidentsCheckedAt, incidentFromTruck))
        .addTo(map)
      const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { popup.remove(); button.focus() } }
      document.addEventListener('keydown', onKey)
      popup.on('close', () => {
        document.removeEventListener('keydown', onKey)
        if (trafficPopupRef.current?.popup === popup) trafficPopupRef.current = null
      })
      trafficPopupRef.current = { id: incident.id, popup }
    }
    for (const incident of incidents) {
      let marker = markers.get(incident.id)
      if (!marker) {
        const element = document.createElement('button')
        element.type = 'button'
        const time = document.createElement('span')
        time.className = 'traffic-incident-time'
        element.append(warningIcon(), time)
        marker = new Marker({ element }).setLngLat(incident.coordinate).addTo(map)
        markers.set(incident.id, marker)
      }
      const element = marker.getElement()
      marker.setLngLat(incident.coordinate)
      setMarkerClass(element, `traffic-incident-marker traffic-incident-${incident.level.toLowerCase()}`)
      const summary = `${INCIDENT_TITLES[incident.level]}${incident.delaySeconds > 0 ? `, ${formatDelay(incident.delaySeconds)}` : ''}`
      // The time a jam costs is written next to its icon, so the map reads without a click.
      const time = element.querySelector<HTMLElement>('.traffic-incident-time')
      if (time) time.textContent = incident.level === 'CLOSED' ? 'перекрыто' : incident.delaySeconds > 0 ? formatDelay(incident.delaySeconds) : ''
      element.title = summary
      element.setAttribute('aria-label', `${summary}. Подробнее о пробке`)
      element.onclick = (event) => { event.stopPropagation(); openPopup(incident, element, event.detail === 0) }
      // An open window follows the data: the truck moves closer, the jam grows or shrinks.
      if (trafficPopupRef.current?.id === incident.id) trafficPopupRef.current.popup.setDOMContent(incidentDetails(incident, incidentsCheckedAt, incidentFromTruck))
    }
    if (trafficPopupRef.current && !wanted.has(trafficPopupRef.current.id)) trafficPopupRef.current.popup.remove()
  }, [incidents, incidentsCheckedAt, incidentFromTruck, styleVersion])

  // Which Autobahn the route takes: a blue A7 / yellow B3 shield on each stretch ahead, like on the road signs.
  const shields = useMemo(() => previewRoute?.length
    ? roadShields(previewRoute, previewRoads)
    : roadShields(fullRoute, position?.roadSegments, { startIndex: travelledIndex }),
  [fullRoute, position?.roadSegments, travelledIndex, previewRoute, previewRoads])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const markers = shieldMarkersRef.current
    const wanted = new Set(shields.map((shield) => shield.id))
    for (const [id, marker] of markers) {
      if (!wanted.has(id)) { marker.remove(); markers.delete(id) }
    }
    for (const shield of shields) {
      let marker = markers.get(shield.id)
      if (!marker) {
        const element = document.createElement('div')
        element.setAttribute('role', 'img')
        marker = new Marker({ element }).setLngLat(shield.coordinate).addTo(map)
        markers.set(shield.id, marker)
      }
      const element = marker.getElement()
      marker.setLngLat(shield.coordinate)
      setMarkerClass(element, `road-shield road-shield-${shield.kind.toLowerCase()}`)
      element.textContent = shield.road
      element.title = roadShieldLabel(shield)
      element.setAttribute('aria-label', roadShieldLabel(shield))
    }
    // Shields never cover each other or a jam icon: at country zoom only the main ones stay, the rest appear closer in.
    declutterShieldsRef.current = () => {
      const container = map.getContainer().getBoundingClientRect()
      const boxOf = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left - container.left, top: rect.top - container.top, right: rect.right - container.left, bottom: rect.bottom - container.top }
      }
      const blockers = [...trafficMarkersRef.current.values()].map((marker) => boxOf(marker.getElement()))
      const candidates = shields.flatMap((shield) => {
        const element = markers.get(shield.id)?.getElement()
        if (!element) return []
        const point = map.project(shield.coordinate)
        // A shield off the map has no size: the one measured while it was shown is kept.
        if (element.offsetWidth) Object.assign(element.dataset, { width: String(element.offsetWidth), height: String(element.offsetHeight) })
        const width = Number(element.dataset.width) || 32
        const height = Number(element.dataset.height) || 20
        return [{ id: shield.id, box: { left: point.x - width / 2, top: point.y - height / 2, right: point.x + width / 2, bottom: point.y + height / 2 } }]
      })
      const visible = visibleShields(candidates, blockers)
      // A hidden shield leaves the map: the map would otherwise move it with every frame of a pan or zoom.
      for (const [id, marker] of markers) {
        const shown = marker.getElement().isConnected
        if (visible.has(id) && !shown) marker.addTo(map)
        else if (!visible.has(id) && shown) marker.remove()
      }
    }
    declutterShieldsRef.current()
  }, [shields, incidents, styleVersion])

  useEffect(() => {
    const map = mapRef.current
    if (map && focusCoordinate) map.easeTo({ center: focusCoordinate, zoom: Math.max(map.getZoom(), 14), duration: 350 })
  }, [focusCoordinate])

  // Fit once per route search: picking another variant must not move the camera.
  const previewFitKey = previewKey ?? previewRoute
  useEffect(() => {
    const map = mapRef.current
    if (map && previewRoute?.length) fitRoute(map, [...previewRoute, ...(previewAlternatives ?? []).flatMap((item) => item.geometry), ...(previewStops ?? []).map((stop) => stop.coordinate)], FIT_MAX_ZOOM, 350, fitPadding(containerRef.current, fillRef.current))
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
    fitRoute(map, previewRoute?.length ? previewRoute : [...fullRoute, ...stopCoordinates(stops)], FIT_MAX_ZOOM, 260, fitPadding(containerRef.current, fillRef.current))
    setCameraRequest(null)
  }, [cameraRequest, fullRoute, position?.coordinate, previewRoute, stops])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleReadyRef.current) return
    const data = { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: track ?? [] } }
    const source = map.getSource('vehicle-track') as GeoJSONSource | undefined
    if (source) source.setData(data)
    else {
      map.addSource('vehicle-track', { type: 'geojson', data })
      map.addLayer({ id: 'vehicle-track', type: 'line', source: 'vehicle-track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7c3aed', 'line-width': 4, 'line-opacity': 0.8 } })
    }
    if (track && track.length > 1) {
      const bounds = boundsFor(track)
      if (bounds) map.fitBounds([bounds[0], bounds[1]], { padding: fitPadding(containerRef.current, fillRef.current), maxZoom: FIT_MAX_ZOOM, duration: 400 })
    }
  }, [track, styleVersion])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const markers = fleetMarkersRef.current
    const shown = new Set<string>()
    for (const vehicle of fleet ?? []) {
      if (vehicle.id === selectedVehicleId) continue
      shown.add(vehicle.id)
      let marker = markers.get(vehicle.id)
      if (!marker) {
        const element = document.createElement('button')
        element.type = 'button'
        element.addEventListener('click', (event) => {
          event.stopPropagation()
          onSelectFleetRef.current?.(vehicle.id)
        })
        marker = new Marker({ element, anchor: 'center' }).setLngLat(vehicle.coordinate).addTo(map)
        markers.set(vehicle.id, marker)
      } else {
        marker.setLngLat(vehicle.coordinate)
      }
      drawFleetMarker(marker.getElement() as HTMLButtonElement, vehicle)
    }
    for (const [id, marker] of markers) {
      if (shown.has(id)) continue
      marker.remove()
      markers.delete(id)
    }
    reclusterRef.current = () => clusterFleet(map, markers, clusterMarkersRef)
    reclusterRef.current()
  }, [fleet, selectedVehicleId])

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
      // The card is also reachable from the list, so the canvas marker stays a plain click target.
      element.addEventListener('click', (event) => {
        event.stopPropagation()
        if (selectedIdRef.current) onSelectFleetRef.current?.(selectedIdRef.current)
      })
      markerRef.current = new Marker({ element }).setLngLat(coordinate).addTo(map)
    } else {
      markerRef.current.setLngLat(coordinate)
    }
    const element = markerRef.current.getElement()
    element.setAttribute('aria-label', markerDescription(vehicleNumber, position?.positionSource))
    element.innerHTML = ''
    const label = document.createElement('span')
    label.className = 'truck-marker-label'
    label.innerHTML = TRUCK_ICON
    label.append(document.createTextNode(vehicleNumber ? `LKW ${vehicleNumber}` : 'LKW'))
    if (position?.positionSource !== 'WEBFLEET') {
      const source = document.createElement('small')
      source.textContent = position?.positionSource === 'MANUAL' ? 'вручную' : 'расчёт'
      label.append(source)
    }
    element.append(label)
  }, [position?.coordinate, position?.positionSource, vehicleNumber])

  return (
    <section className={[fill ? 'map-panel-fill' : 'map-panel-card work-surface relative min-w-0 overflow-hidden', labels ? '' : 'fleet-labels-off'].join(' ')}>
      <div ref={containerRef} style={{ height }} className={fill ? 'h-full w-full' : 'rounded-lg'} />
      <div className="map-zoom" role="group" aria-label="Масштаб карты">
        <button type="button" onClick={() => mapRef.current?.zoomIn()} aria-label="Приблизить" title="Приблизить"><Plus className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" onClick={() => mapRef.current?.zoomOut()} aria-label="Отдалить" title="Отдалить"><Minus className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" onClick={() => setCameraRequest('vehicle')} disabled={!position?.coordinate} aria-label="К машине" title="Показать выбранную машину"><LocateFixed className="h-4 w-4" aria-hidden="true" /></button>
      </div>
      <div className="map-layers" aria-label="Слои карты">
        <button type="button" className="map-layer-button" aria-pressed={traffic} onClick={() => setTraffic((value) => !value)} title={tomTomMapKey() ? 'Пробки TomTom на карте' : 'Пробки на карте нужны с ключом TomTom'}><TriangleAlert className="h-4 w-4" aria-hidden="true" />Пробки</button>
        <div className="map-segment" role="group" aria-label="Подложка">
          <button type="button" aria-pressed={mode === 'map'} onClick={() => setMode('map')}>Карта</button>
          <button type="button" aria-pressed={mode === 'satellite'} onClick={() => setMode('satellite')}>Спутник</button>
        </div>
        <button type="button" className="map-layer-button map-layer-icon" aria-pressed={labels} onClick={() => setLabels((value) => !value)} aria-label="Номера машин на карте" title="Номера машин на карте"><Layers className="h-4 w-4" aria-hidden="true" /></button>
        {sourceNote ? <button type="button" className="map-layer-button map-layer-icon" aria-pressed={lite} aria-expanded={Boolean(diagnostics)} aria-controls="map-diagnostics" onClick={toggleDiagnostics} aria-label="Скорость карты" title={lite ? 'Скорость карты: лёгкий режим включён' : 'Скорость карты'}><Gauge className="h-4 w-4" aria-hidden="true" /></button> : null}
      </div>
      {sourceNote ? <div className="map-provider-note">{tomTomMapKey() ? (traffic ? 'TomTom · пробки онлайн' : 'TomTom · без пробок') : 'OSM · без live-пробок'}{lite ? ' · лёгкий режим' : ''}</div> : null}
      {sourceNote && diagnostics ? <MapDiagnosticsCard info={diagnostics} lite={lite} auto={liteChoice === 'auto' && autoLite} onLite={chooseLite} onClose={() => setDiagnostics(null)} /> : null}
      <TrafficLegend segments={previewRoute?.length ? previewTraffic : position?.trafficSegments} checkedAt={previewRoute?.length ? null : position?.trafficCheckedAt} />
    </section>
  )
}

type MapDiagnostics = { renderer: string | null; fps: number | null; canvas: [number, number]; scale: number }

function readDiagnostics(map: Map | null, fps: number | null): MapDiagnostics {
  const canvas = map?.getCanvas()
  let renderer: string | null = null
  try {
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    if (gl && info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
  } catch { /* The browser may hide the graphics card. */ }
  return { renderer, fps, canvas: [canvas?.width ?? 0, canvas?.height ?? 0], scale: Math.round(window.devicePixelRatio * 100) }
}

/** What draws the map on this computer and how fast: the answer to «карта тормозит» without guessing. */
function MapDiagnosticsCard({ info, lite, auto, onLite, onClose }: { info: MapDiagnostics; lite: boolean; auto: boolean; onLite: (on: boolean) => void; onClose: () => void }) {
  const kind = rendererKind(info.renderer)
  return <div id="map-diagnostics" className="map-diagnostics" role="dialog" aria-label="Скорость карты">
    <header><strong>Скорость карты</strong><button type="button" onClick={onClose} aria-label="Закрыть">×</button></header>
    <dl>
      <div><dt>Рисует</dt><dd>{kind === 'software' ? 'процессор (без видеокарты)' : kind === 'gpu' ? `видеокарта ${rendererLabel(info.renderer)}` : 'не определено'}</dd></div>
      <div><dt>Кадров в секунду</dt><dd>{info.fps === null ? 'подвигайте карту и откройте снова' : `${info.fps} при последнем движении`}</dd></div>
      <div><dt>Холст</dt><dd>{info.canvas[0]} × {info.canvas[1]} пикс., масштаб экрана {info.scale} %</dd></div>
    </dl>
    {kind === 'software' ? <p className="map-diagnostics-warning">В браузере выключено аппаратное ускорение, поэтому карта тормозит. Chrome: Настройки → Система → «Использовать графическое ускорение», затем перезапустить браузер.</p> : null}
    <label><input type="checkbox" checked={lite} onChange={(event) => onLite(event.target.checked)} /> Лёгкий режим: быстрее, линии чуть менее чёткие</label>
    {auto ? <small>Включён сам: карта двигалась медленнее 24 кадров в секунду.</small> : null}
  </div>
}

// Google-style route: white casing, blue line, congestion on top, travelled part grey.
const ROUTE_BLUE = '#1a73e8'
const PREVIEW_BLUE = '#174ea6'
const ALT_GREY = '#8fa3bf'
const TRAFFIC_LABELS = { SLOW: 'медленно', JAM: 'пробка', STANDSTILL: 'стоит', CLOSED: 'перекрыто' } as const
const LINE_WIDTH = ['interpolate', ['linear'], ['zoom'], 5, 4.5, 10, 8.5, 14, 13] as unknown as number
const CASING_WIDTH = ['interpolate', ['linear'], ['zoom'], 5, 7.5, 10, 12, 14, 17] as unknown as number
const TRAFFIC_COLOR = ['match', ['get', 'level'], 'SLOW', TRAFFIC_COLORS.SLOW, 'JAM', TRAFFIC_COLORS.JAM, 'STANDSTILL', TRAFFIC_COLORS.STANDSTILL, 'CLOSED', TRAFFIC_COLORS.CLOSED, ROUTE_BLUE] as unknown as string
const TRAFFIC_FLOW_OPACITY = 0.9
const TRAFFIC_FLOW_OPACITY_WITH_ROUTE = 0.5

const STALE_TRAFFIC_MS = 30 * 60_000

function incidentDetails(incident: TrafficIncident, checkedAt: string | null | undefined, fromTruck: boolean) {
  const root = document.createElement('div')
  root.className = 'traffic-incident-details'
  // The delay is what the dispatcher acts on, so it leads, in the colour of the jam on the line.
  const header = document.createElement('header')
  const title = document.createElement('strong')
  title.textContent = INCIDENT_TITLES[incident.level]
  header.append(title)
  if (incident.delaySeconds >= 60) {
    const delay = document.createElement('span')
    delay.className = `traffic-incident-delay traffic-incident-delay-${incident.level.toLowerCase()}`
    delay.textContent = formatDelay(incident.delaySeconds)
    delay.setAttribute('aria-label', `Задержка ${formatDelay(incident.delaySeconds)}`)
    header.append(delay)
  }
  root.append(header)
  const list = document.createElement('dl')
  const row = (label: string, value: string) => {
    const item = document.createElement('div')
    const term = document.createElement('dt')
    term.textContent = label
    const detail = document.createElement('dd')
    detail.textContent = value
    item.append(term, detail)
    list.append(item)
  }
  if (incident.delaySeconds < 60) row('Задержка', 'нет данных')
  row('Длина', formatKm(incident.lengthMeters))
  if (incident.speedKmh !== null) row('Скорость', `~${incident.speedKmh} км/ч`)
  row(fromTruck ? 'До пробки' : 'От начала маршрута', incident.distanceAheadMeters < 100 ? (fromTruck ? 'машина в пробке' : 'в начале') : formatKm(incident.distanceAheadMeters))
  root.append(list)
  const at = checkedAt ? new Date(checkedAt) : null
  if (at && Number.isFinite(at.getTime())) {
    const note = document.createElement('small')
    const stale = Date.now() - at.getTime() > STALE_TRAFFIC_MS
    note.className = stale ? 'traffic-incident-stale' : ''
    note.textContent = `${stale ? 'Данные устарели · ' : 'Данные '}${at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
    root.append(note)
  }
  return root
}

function warningIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  // lucide «triangle-alert», the icon set used across the app.
  for (const d of ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/**
 * Every line except the grey travelled part, which moves with the truck and is drawn on its own (above these, below the preview).
 * A casing and its line share one source: the map cuts each source into tiles again at every zoom level.
 */
function renderRouteLayers(map: Map, fullRoute: Coordinate[], breaks: number[] | null, traffic?: TrafficSegment[], previewRoute?: Coordinate[], previewTraffic?: TrafficSegment[], previewAlternatives?: MapRouteAlternative[]) {
  upsertRouteLayer(map, 'route-casing', toBrokenLine(fullRoute, breaks), { 'line-color': '#ffffff', 'line-width': CASING_WIDTH, 'line-opacity': 0.95 })
  addLineLayer(map, 'route-main', 'route-casing-source', { 'line-color': ROUTE_BLUE, 'line-width': LINE_WIDTH })
  upsertRouteLayer(map, 'route-traffic', trafficFeatures(fullRoute, traffic), { 'line-color': TRAFFIC_COLOR, 'line-width': LINE_WIDTH })
  const preview = previewRoute ?? []
  const alternatives = { type: 'FeatureCollection' as const, features: (previewAlternatives ?? []).filter((item) => item.geometry.length >= 2)
    .map((item) => ({ type: 'Feature' as const, properties: { id: item.id }, geometry: { type: 'LineString' as const, coordinates: item.geometry } })) }
  upsertRouteLayer(map, 'preview-alt-casing', alternatives, { 'line-color': '#ffffff', 'line-width': CASING_WIDTH, 'line-opacity': 0.9 })
  addLineLayer(map, 'preview-alt', 'preview-alt-casing-source', { 'line-color': ALT_GREY, 'line-width': LINE_WIDTH })
  addLineLayer(map, 'preview-alt-hit', 'preview-alt-casing-source', { 'line-color': '#000000', 'line-width': 20, 'line-opacity': 0 })
  upsertRouteLayer(map, 'preview-casing', toLineString(preview), { 'line-color': '#ffffff', 'line-width': CASING_WIDTH, 'line-opacity': 0.95 })
  addLineLayer(map, 'preview-main', 'preview-casing-source', { 'line-color': PREVIEW_BLUE, 'line-width': LINE_WIDTH })
  upsertRouteLayer(map, 'preview-traffic', trafficFeatures(preview, previewTraffic), { 'line-color': TRAFFIC_COLOR, 'line-width': LINE_WIDTH })
  // The route must stand out: dim the city-wide traffic layer while a route is shown.
  if (map.getLayer('traffic-flow')) {
    map.setPaintProperty('traffic-flow', 'line-opacity',fullRoute.length > 1 || preview.length > 1 ? TRAFFIC_FLOW_OPACITY_WITH_ROUTE : TRAFFIC_FLOW_OPACITY)
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

// OSM has no night tiles: invert the brightness and turn the hues back, so water stays blue and forests green.
const OSM_NIGHT_PAINT = { 'raster-brightness-min': 0.94, 'raster-brightness-max': 0.06, 'raster-hue-rotate': 180, 'raster-saturation': -0.55, 'raster-contrast': 0.12 } as const

function styleFor(mode: MapMode, traffic: boolean, theme: Theme): StyleSpecification {
  const key = tomTomMapKey()
  const night = theme === 'dark' && mode !== 'satellite'
  if (!key) {
    if (mode === 'satellite') return fallbackSatelliteStyle
    return night ? { ...osmStyle, layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { ...OSM_NIGHT_PAINT, 'raster-fade-duration': 0 } }] } : osmStyle
  }
  const baseTile = mode === 'satellite'
    ? `https://api.tomtom.com/map/1/tile/sat/main/{z}/{x}/{y}.jpg?key=${key}`
    : `https://api.tomtom.com/map/1/tile/basic/${night ? 'night' : 'main'}/{z}/{x}/{y}.png?key=${key}`
  const sources: StyleSpecification['sources'] = {
    base: { type: 'raster', tiles: [baseTile], tileSize: 256, attribution: '© TomTom, © OpenStreetMap contributors' }
  }
  // Tiles appear at once: fading each new tile in kept the map redrawing through a whole zoom.
  const layers: StyleSpecification['layers'] = [{ id: 'base', type: 'raster', source: 'base', paint: { 'raster-fade-duration': 0 } }]
  if (traffic) {
    // Vector flow tiles: only the slow stretches are drawn, along the road and thick enough to see at country zoom (as in Webfleet).
    sources.traffic = {
      type: 'vector',
      tiles: [trafficTileUrl(key)],
      maxzoom: TRAFFIC_MAX_TILE_ZOOM
    }
    layers.push(trafficFlowLayer(TRAFFIC_FLOW_OPACITY))
  }
  return { version: 8, sources, layers }
}


function tomTomMapKey(): string | undefined {
  return (import.meta.env.VITE_TOMTOM_MAPS_KEY || import.meta.env.VITE_TOMTOM_MAP_KEY) as string | undefined
}

type Padding = number | { top: number; right: number; bottom: number; left: number }

/** The bottom panel's height changes (strip, open, route stops): it is measured each time the map fits a route. */
function fitPadding(container: HTMLElement | null, fill: boolean | undefined): Padding {
  if (!fill) return 64
  const panel = container?.closest('.dashboard-stage')?.querySelector<HTMLElement>('.vehicle-panel')
  return { top: 96, right: 80, bottom: panel ? Math.max(96, panel.offsetHeight + 40) : 96, left: 88 }
}

function fitRoute(map: Map | null, coordinates: Coordinate[], maxZoom: number, duration: number, padding: Padding = 64) {
  if (!map) return
  const bounds = boundsFor(coordinates)
  if (bounds) {
    map.fitBounds([bounds[0], bounds[1]], { padding, maxZoom, duration })
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

function readStored(key: string) { try { return window.localStorage.getItem(key) } catch { return null } }
function readMapMode(): MapMode { return readStored('ops-dashboard-map-mode') === 'satellite' ? 'satellite' : 'map' }
function readTraffic() { return readStored('ops-dashboard-map-traffic') !== '0' }
function readLabels() { return readStored('ops-dashboard-map-labels') !== '0' }

const TRUCK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>'
const CLUSTER_CELL_PX = 64
const CLUSTER_MAX_ZOOM = 9

/** Trucks that would overlap at this zoom become one grey circle with their count; a click zooms into them. */
function clusterFleet(map: Map, markers: globalThis.Map<string, Marker>, clusterRef: { current: Marker[] }) {
  clusterRef.current.forEach((marker) => marker.remove())
  clusterRef.current = []
  const cells = new globalThis.Map<string, Marker[]>()
  const clustering = map.getZoom() < CLUSTER_MAX_ZOOM
  for (const marker of markers.values()) {
    marker.getElement().hidden = false
    if (!clustering) continue
    const point = map.project(marker.getLngLat())
    const key = `${Math.floor(point.x / CLUSTER_CELL_PX)}:${Math.floor(point.y / CLUSTER_CELL_PX)}`
    cells.set(key, [...(cells.get(key) ?? []), marker])
  }
  for (const group of cells.values()) {
    if (group.length < 2) continue
    const bounds = new LngLatBounds()
    let lng = 0
    let lat = 0
    for (const marker of group) {
      marker.getElement().hidden = true
      const at = marker.getLngLat()
      bounds.extend(at)
      lng += at.lng
      lat += at.lat
    }
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'fleet-cluster'
    element.textContent = String(group.length)
    element.setAttribute('aria-label', `${group.length} машин рядом. Приблизить`)
    element.addEventListener('click', (event) => {
      event.stopPropagation()
      map.fitBounds(bounds, { padding: 80, maxZoom: CLUSTER_MAX_ZOOM + 1, duration: 300 })
    })
    clusterRef.current.push(new Marker({ element, anchor: 'center' }).setLngLat([lng / group.length, lat / group.length]).addTo(map))
  }
}

const FLEET_SOURCE_TEXT: Record<FleetMapVehicle['source'], string> = { WEBFLEET: 'GPS', MANUAL: 'указана вручную', CALCULATED: 'расчёт' }

/** MapLibre positions a marker through its own maplibregl-* classes; replacing className would drop them and the marker would slide to the corner. */
function setMarkerClass(element: HTMLElement, value: string) {
  element.className = [value, ...Array.from(element.classList).filter((name) => name.startsWith('maplibregl-'))].join(' ')
}

const TONE_TEXT: Record<FleetTone, string> = { ok: 'в пути', stop: 'на точке', late: 'опоздание', plan: 'план', idle: 'без тура' }

function drawFleetMarker(element: HTMLButtonElement, vehicle: FleetMapVehicle) {
  const source = vehicle.source === 'WEBFLEET' ? (vehicle.stale ? 'stale' : 'live') : 'calculated'
  const tone = vehicle.tone ?? 'idle'
  const sourceText = vehicle.source === 'WEBFLEET' && vehicle.stale ? 'GPS устарел' : FLEET_SOURCE_TEXT[vehicle.source]
  const motion = vehicle.source !== 'WEBFLEET' ? '' : vehicle.standstill === true ? ', стоит' : vehicle.standstill === false ? ', едет' : ''
  const key = `${source}|${tone}|${vehicle.label}|${vehicle.termin ? 't' : ''}`
  if (element.dataset.key === key) return
  element.dataset.key = key
  setMarkerClass(element, `fleet-marker fleet-marker-${source} fleet-marker-tone-${tone}${vehicle.termin ? ' fleet-marker-termin' : ''}`)
  element.setAttribute('aria-label', `LKW ${vehicle.label}: ${TONE_TEXT[tone]}, ${sourceText}${motion}${vehicle.termin ? ', есть Termin' : ''}. Открыть карточку`)
  element.title = `LKW ${vehicle.label} · ${TONE_TEXT[tone]} · ${sourceText}${motion}`
  element.replaceChildren()
  const dot = document.createElement('span')
  dot.className = 'fleet-marker-dot'
  dot.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.className = 'fleet-marker-label'
  label.textContent = `LKW ${vehicle.label}`
  element.append(dot, label)
  if (tone === 'late') {
    const warn = document.createElement('span')
    warn.className = 'fleet-marker-warn'
    warn.setAttribute('aria-hidden', 'true')
    warn.textContent = '!'
    element.append(warn)
  }
  if (source !== 'live') {
    const tag = document.createElement('small')
    tag.className = 'fleet-marker-source'
    tag.textContent = source === 'stale' ? 'GPS устар.' : 'расчёт'
    element.append(tag)
  }
}

function markerDescription(vehicleNumber?: string | null, source?: CurrentPosition['positionSource']): string {
  return `${vehicleNumber ? `LKW ${vehicleNumber}` : 'Грузовик'} · ${source === 'WEBFLEET' ? 'фактическая позиция Webfleet GPS' : source === 'MANUAL' ? 'позиция, указанная диспетчером вручную' : calculatedPositionLabel}`
}

function upsertRouteLayer(map: Map, id: string, data: GeoJSON.Feature | GeoJSON.FeatureCollection, paint: Record<string, unknown>, beforeId?: string) {
  const sourceId = `${id}-source`
  const source = map.getSource(sourceId) as GeoJSONSource | undefined
  if (source) {
    source.setData(data)
    return
  }
  map.addSource(sourceId, { type: 'geojson', data })
  addLineLayer(map, id, sourceId, paint, beforeId)
}

/** A line layer over a source that already exists (a second look of the same line); added once, then left alone. */
function addLineLayer(map: Map, id: string, sourceId: string, paint: Record<string, unknown>, beforeId?: string) {
  if (map.getLayer(id)) return
  map.addLayer({ id, type: 'line', source: sourceId, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint } as Parameters<Map['addLayer']>[0], beforeId)
}

function setTrafficVisible(map: Map | null, visible: boolean) {
  if (map?.getLayer('traffic-flow')) map.setLayoutProperty('traffic-flow', 'visibility', visible ? 'visible' : 'none')
}
