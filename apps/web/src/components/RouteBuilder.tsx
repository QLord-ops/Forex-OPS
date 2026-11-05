import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertTriangle, GripVertical, LoaderCircle, MapPin, Plus, Route, Truck, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { suggestionAddress } from '../lib/address-book'
import { previewRouteScenario, type RouteScenarioRequest } from '../lib/assistant-api'
import { formatAppointment } from '../lib/format'
import type { MapRoutePreview } from '../lib/route-preview'
import { chosenOption, composeRoute, formatDrive, formatRouteKm } from '../lib/route-variants'
import { looksLikeVehicleReference, vehicleMatch, type VehicleMatch } from '../lib/vehicle-match'
import type { RouteLeg, RouteScenario } from '../types/assistant'
import type { Vehicle } from '../types/domain'
import { AddressInput, type ExtraOption } from './AddressInput'
import { RouteVariants } from './RouteVariants'

export const MAX_ROUTE_POINTS = 10
/** A picked saved address carries exact coordinates: the server does not geocode that point again. */
type RoutePoint = { id: string; value: string; coords?: { latitude: number; longitude: number } }

let pointSequence = 0
const newPoint = (value = ''): RoutePoint => ({ id: `point-${++pointSequence}`, value })

export function RouteBuilder({ vehicles, selectedVehicleNumber, onPreview }: {
  vehicles: Vehicle[]
  selectedVehicleNumber?: string | null
  onPreview: (preview: MapRoutePreview | null) => void
}) {
  const [points, setPoints] = useState<RoutePoint[]>(() => [newPoint(selectedVehicleNumber ? `LKW ${selectedVehicleNumber}` : ''), newPoint()])
  const [result, setResult] = useState<RouteScenario | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [legs, setLegs] = useState<RouteLeg[]>([])
  const [choice, setChoice] = useState<number[]>([])
  const [activeLeg, setActiveLeg] = useState(0)
  const [retiming, setRetiming] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const retimeController = useRef<AbortController | null>(null)
  // The search the variants belong to: its request (with resolved coordinates) and its original forecast.
  const base = useRef<{ request: RouteScenarioRequest; result: RouteScenario; label: string; stopsOnMap: MapRoutePreview['stops']; key: string } | null>(null)
  const lastPreview = useRef<MapRoutePreview | null>(null)
  const chooseRef = useRef<(legIndex: number, optionIndex: number) => void>(() => undefined)
  const onPreviewRef = useRef(onPreview)
  onPreviewRef.current = onPreview

  function publish(preview: MapRoutePreview | null) {
    lastPreview.current = preview
    onPreviewRef.current(preview)
  }

  const sensors = useSensors(
    // Press and hold the handle: a click into the field never starts a drag, and it works with a finger.
    useSensor(PointerSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  useEffect(() => () => {
    controller.current?.abort()
    retimeController.current?.abort()
    // With the window closed nobody can switch variants: keep the chosen route, drop the clickable grey ones.
    const last = lastPreview.current
    if (last?.alternatives?.length) onPreviewRef.current({ ...last, alternatives: undefined, onSelectAlternative: undefined })
  }, [])
  useEffect(() => {
    setPoints((current) => {
      const first = current[0]
      if (first.value.trim() && !looksLikeVehicleReference(first.value)) return current
      return [{ ...first, value: selectedVehicleNumber ? `LKW ${selectedVehicleNumber}` : '' }, ...current.slice(1)]
    })
  }, [selectedVehicleNumber])

  const matches = useMemo(() => points.map((point) => looksLikeVehicleReference(point.value) || vehicleMatch(point.value, vehicles).status === 'MATCHED'
    ? vehicleMatch(point.value, vehicles) : null), [points, vehicles])
  const start = matches[0]
  const misplacedVehicle = matches.findIndex((match, index) => index > 0 && match?.status === 'MATCHED')

  function invalidate() {
    controller.current?.abort()
    controller.current = null
    retimeController.current?.abort()
    retimeController.current = null
    base.current = null
    setResult(null)
    setLegs([]); setChoice([]); setActiveLeg(0); setRetiming(false)
    setBusy(false)
    setError('')
    publish(null)
  }

  function showOnMap(nextLegs: RouteLeg[], nextChoice: number[], leg: number, scenario: RouteScenario) {
    const search = base.current
    if (!search) return
    const composed = nextLegs.length ? composeRoute(nextLegs, nextChoice) : { geometry: scenario.geometry, trafficSegments: scenario.trafficSegments ?? [], roadSegments: [] }
    if (composed.geometry.length < 2) { publish(null); return }
    const alternatives = (nextLegs[leg]?.options ?? [])
      .map((option, index) => ({ option, index }))
      .filter(({ index }) => index !== (nextChoice[leg] ?? 0))
      .map(({ option, index }) => ({ id: `${leg}:${index}`, geometry: option.geometry, label: formatDrive(option.durationSeconds) }))
    publish({ geometry: composed.geometry, trafficSegments: composed.trafficSegments, roadSegments: composed.roadSegments, label: search.label, stops: search.stopsOnMap, key: search.key,
      alternatives, onSelectAlternative: (id) => { const [legIndex, optionIndex] = id.split(':').map(Number); chooseRef.current(legIndex, optionIndex) } })
  }

  async function retime(nextChoice: number[]) {
    const search = base.current
    if (!search) return
    retimeController.current?.abort()
    retimeController.current = null
    if (nextChoice.every((value) => !value)) { setResult(search.result); setRetiming(false); return }
    const request = new AbortController()
    retimeController.current = request
    setRetiming(true); setError('')
    try {
      const legChoices = legs.map((leg, index) => {
        const option = chosenOption(leg, nextChoice[index])
        return option ? { distanceMeters: option.distanceMeters, durationSeconds: option.durationSeconds } : null
      })
      const retimed = await previewRouteScenario({ ...search.request, legChoices }, request.signal)
      if (!request.signal.aborted) setResult(retimed)
    } catch {
      if (!request.signal.aborted) setError('Не удалось пересчитать ETA для выбранного варианта. Время ниже — для прежнего варианта.')
    } finally {
      if (retimeController.current === request) { retimeController.current = null; setRetiming(false) }
    }
  }

  function choose(legIndex: number, optionIndex: number) {
    const search = base.current
    if (!search || !legs[legIndex]?.options[optionIndex]) return
    const nextChoice = legs.map((_, index) => index === legIndex ? optionIndex : choice[index] ?? 0)
    setActiveLeg(legIndex)
    showOnMap(legs, nextChoice, legIndex, search.result)
    if (optionIndex === (choice[legIndex] ?? 0)) return
    setChoice(nextChoice)
    void retime(nextChoice)
  }
  chooseRef.current = choose

  function switchLeg(index: number) {
    if (!base.current) return
    setActiveLeg(index)
    showOnMap(legs, choice, index, base.current.result)
  }

  function update(id: string, value: string, coords?: RoutePoint['coords']) { invalidate(); setPoints((current) => current.map((point) => point.id === id ? { ...point, value, coords } : point)) }
  function add() { if (points.length >= MAX_ROUTE_POINTS) return; invalidate(); setPoints((current) => [...current, newPoint()]) }
  function remove(id: string) { if (points.length <= 2) return; invalidate(); setPoints((current) => current.filter((point) => point.id !== id)) }
  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    invalidate()
    setPoints((current) => arrayMove(current, current.findIndex((point) => point.id === active.id), current.findIndex((point) => point.id === over.id)))
  }

  async function calculate() {
    const filled = points.map((point) => point.value.trim())
    if (filled.some((value) => !value)) { setError('Заполните все точки или удалите пустые.'); return }
    if (misplacedVehicle > 0) { setError(`Машину можно указать только первой точкой. Сейчас она в точке ${misplacedVehicle + 1}.`); return }
    if (start?.status === 'AMBIGUOUS') { setError(`Номер подходит нескольким машинам: ${start.candidates?.map((vehicle) => `LKW ${vehicle.vehicleNumber}`).join(', ')}. Укажите госномер.`); return }
    if (start?.status === 'NOT_FOUND') { setError('Машина не найдена. Укажите её номер, госномер или начальный адрес.'); return }

    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    retimeController.current?.abort()
    base.current = null
    setBusy(true); setError(''); setResult(null); setLegs([]); setChoice([]); setActiveLeg(0); setRetiming(false); publish(null)
    try {
      const stops = filled.slice(1).map((address, index) => ({ address, ...(points[index + 1]?.coords ? { coords: points[index + 1]!.coords } : {}) }))
      const body: RouteScenarioRequest = start?.status === 'MATCHED'
        ? { vehicleId: start.id, startMode: 'NOW', includeQueueImpact: false, stops }
        : { originAddress: filled[0], stops }
      const scenario = await previewRouteScenario(body, request.signal)
      if (request.signal.aborted) return
      const labels = filled.slice(1)
      // Variants only when every draft leg was routed; otherwise the plain line is shown.
      const nextLegs = scenario.legs?.length === scenario.stops.length ? scenario.legs : []
      const nextChoice = nextLegs.map(() => 0)
      base.current = {
        request: { ...body, stops: scenario.stops.map((stop, index) => ({ address: stops[index]?.address ?? stop.address, coords: stop.coords })) },
        result: scenario,
        label: start?.vehicle ? `Маршрут LKW ${start.vehicle.vehicleNumber}` : 'Предпросмотр маршрута',
        stopsOnMap: scenario.stops.map((stop, index) => ({ coordinate: [stop.coords.longitude, stop.coords.latitude], label: String(index + 2), title: labels[index] ?? stop.address })),
        key: `route-${Date.now()}`
      }
      setResult(scenario)
      setLegs(nextLegs); setChoice(nextChoice)
      showOnMap(nextLegs, nextChoice, 0, scenario)
    } catch (cause) {
      if (request.signal.aborted) return
      setError(cause instanceof Error ? cause.message : 'Не удалось рассчитать маршрут.')
    } finally {
      if (controller.current === request) { controller.current = null; setBusy(false) }
    }
  }

  const durationMinutes = result?.completion.latest ? Math.max(0, Math.round((Date.parse(result.completion.latest) - Date.parse(result.startRange.earliest)) / 60000)) : null
  const live = Boolean((base.current?.result ?? result)?.routingProviders?.some((provider) => provider.toLowerCase().includes('tomtom')))
  const totalMeters = legs.length ? composeRoute(legs, choice).distanceMeters : result?.distanceMeters ?? 0

  return <form className="map-action-content route-builder" onSubmit={(event) => { event.preventDefault(); void calculate() }} aria-label="Построить маршрут">
    <p className="quick-order-hint route-builder-hint">Первая точка — номер машины (например <strong>125</strong>) или начальный адрес. Зажмите <GripVertical className="inline h-3.5 w-3.5" aria-hidden="true" />, чтобы поменять точки местами.</p>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={points.map((point) => point.id)} strategy={verticalListSortingStrategy}>
        <ol className="route-points">
          {points.map((point, index) => <SortablePoint key={point.id} point={point} index={index} total={points.length} match={matches[index]} vehicles={vehicles}
            onChange={(value, coords) => update(point.id, value, coords)} onRemove={() => remove(point.id)} />)}
        </ol>
      </SortableContext>
    </DndContext>
    <button type="button" className="route-add-point" onClick={add} disabled={points.length >= MAX_ROUTE_POINTS}>
      <Plus className="h-4 w-4" aria-hidden="true" />{points.length >= MAX_ROUTE_POINTS ? `Максимум ${MAX_ROUTE_POINTS} точек` : 'Добавить точку'}
    </button>
    <button type="submit" className="primary-button mt-3 w-full" disabled={busy}>
      {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />}{busy ? 'Строим маршрут…' : 'Проложить маршрут'}
    </button>
    {error ? <p className="quick-order-error" role="alert"><AlertTriangle className="h-4 w-4" />{error}</p> : null}
    {result && legs.length ? <RouteVariants legs={legs} choice={choice} activeLeg={activeLeg} busy={retiming} live={live} onActiveLeg={switchLeg} onChoose={choose} /> : null}
    {result ? <div className="manual-scenario-result route-builder-result" aria-live="polite">
      <div className="route-builder-total"><strong>{formatRouteKm(totalMeters)}</strong>{durationMinutes !== null ? <span>{formatDuration(durationMinutes)} в пути{result.stops.length > 1 ? ' со всеми точками' : ''}</span> : null}</div>
      <p className="route-builder-source">{live ? 'TomTom · с учётом пробок' : 'Без актуальных пробок'}{result.vehicleNumber ? ` · старт LKW ${result.vehicleNumber}` : ''}</p>
      <ol className="route-builder-eta">{result.stops.map((stop, index) => {
        const leg = legs[index] ? chosenOption(legs[index], choice[index]) : undefined
        return <li key={index}><span className="route-point-number">{index + 2}</span><span className="min-w-0 truncate">{stop.address}</span>
          {leg ? <span className="route-builder-leg-km" title="Расстояние от предыдущей точки">{formatRouteKm(leg.distanceMeters)}</span> : null}
          <time>{stop.latestArrival ? formatAppointment(stop.latestArrival) : '—'}</time></li>
      })}</ol>
      {result.warnings.map((warning, index) => <p key={index} className="quick-order-warning">{warning}</p>)}
    </div> : null}
  </form>
}

function SortablePoint({ point, index, total, match, vehicles, onChange, onRemove }: {
  point: RoutePoint; index: number; total: number; match: VehicleMatch | null; vehicles: Vehicle[]
  onChange: (value: string, coords?: RoutePoint['coords']) => void; onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: point.id })
  const inputId = `route-point-${point.id}`
  const label = index === 0 ? 'Старт: номер машины или адрес' : index === total - 1 ? 'Конечный адрес' : `Точка ${index + 1}`
  const vehicle = match?.status === 'MATCHED' ? match.vehicle : null
  return <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`route-point ${isDragging ? 'dragging' : ''}`}>
    <button type="button" ref={setActivatorNodeRef} className="route-point-handle" aria-label={`Перетащить точку ${index + 1}`} {...attributes} {...listeners}>
      <GripVertical className="h-4 w-4" aria-hidden="true" />
    </button>
    <span className="route-point-number" aria-hidden="true">{index + 1}</span>
    <div className="min-w-0 flex-1">
      <label className="sr-only" htmlFor={inputId}>{label}</label>
      <AddressInput id={inputId} value={point.value} onChange={(value) => onChange(value)} placeholder={index === 0 ? 'Номер машины или адрес' : 'Город, фирма или адрес'}
        onPick={(item) => onChange(`${item.label}, ${suggestionAddress(item)}`, { latitude: item.latitude, longitude: item.longitude })}
        extraOptions={index === 0 ? vehicleOptions(vehicles, point.value) : undefined} />
      {index > 0 && point.coords ? <small className="route-point-note"><MapPin className="inline h-3.5 w-3.5" aria-hidden="true" /> точные координаты из адресной книги</small> : null}
      {index === 0 && point.value.trim() ? <small className="route-point-note">{vehicle
        ? <><Truck className="inline h-3.5 w-3.5" aria-hidden="true" /> LKW {vehicle.vehicleNumber}{vehicle.licensePlate ? ` · ${vehicle.licensePlate}` : ''} · от текущей позиции</>
        : match?.status === 'AMBIGUOUS' ? 'Несколько машин с таким номером' : match ? 'Машина не найдена' : 'Адрес старта'}</small> : null}
      {index > 0 && vehicle ? <small className="route-point-note route-point-note-error">Машину можно указать только первой точкой</small> : null}
    </div>
    <button type="button" className="icon-button icon-button-compact" onClick={onRemove} disabled={total <= 2} aria-label={`Удалить точку ${index + 1}`}>
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
  </li>
}

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours ? `${hours} ч ${String(rest).padStart(2, '0')} мин` : `${rest} мин`
}

/** Trucks whose number or plate contains what was typed, for the first route point. */
function vehicleOptions(vehicles: Vehicle[], typed: string): ExtraOption[] {
  const query = typed.trim().toLowerCase().replace(/^lkw\s*/, '').replace(/[^a-z0-9äöü]/g, '')
  if (!query) return []
  return vehicles.filter((vehicle) => `${vehicle.vehicleNumber}${vehicle.licensePlate ?? ''}`.toLowerCase().replace(/[^a-z0-9äöü]/g, '').includes(query)).slice(0, 4)
    .map((vehicle) => ({ key: vehicle.id, label: `LKW ${vehicle.vehicleNumber}`, line2: vehicle.licensePlate ?? undefined, value: `LKW ${vehicle.vehicleNumber}` }))
}
