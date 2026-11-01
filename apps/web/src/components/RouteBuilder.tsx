import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertTriangle, GripVertical, LoaderCircle, Plus, Route, Truck, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { previewRouteScenario } from '../lib/assistant-api'
import { formatAppointment } from '../lib/format'
import type { MapRoutePreview } from '../lib/route-preview'
import { looksLikeVehicleReference, vehicleMatch, type VehicleMatch } from '../lib/vehicle-match'
import type { RouteScenario } from '../types/assistant'
import type { Vehicle } from '../types/domain'

export const MAX_ROUTE_POINTS = 10
type RoutePoint = { id: string; value: string }

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
  const controller = useRef<AbortController | null>(null)
  const onPreviewRef = useRef(onPreview)
  onPreviewRef.current = onPreview

  const sensors = useSensors(
    // Press and hold the handle: a click into the field never starts a drag, and it works with a finger.
    useSensor(PointerSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  useEffect(() => () => controller.current?.abort(), [])
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
    setResult(null)
    setBusy(false)
    setError('')
    onPreviewRef.current(null)
  }

  function update(id: string, value: string) { invalidate(); setPoints((current) => current.map((point) => point.id === id ? { ...point, value } : point)) }
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
    setBusy(true); setError(''); setResult(null); onPreviewRef.current(null)
    try {
      const stops = filled.slice(1).map((address) => ({ address }))
      const scenario = await previewRouteScenario(start?.status === 'MATCHED'
        ? { vehicleId: start.id, startMode: 'NOW', includeQueueImpact: false, stops }
        : { originAddress: filled[0], stops }, request.signal)
      if (request.signal.aborted) return
      setResult(scenario)
      const labels = filled.slice(1)
      onPreviewRef.current(scenario.geometry.length >= 2 ? {
        geometry: scenario.geometry,
        label: start?.vehicle ? `Маршрут LKW ${start.vehicle.vehicleNumber}` : 'Предпросмотр маршрута',
        stops: scenario.stops.map((stop, index) => ({ coordinate: [stop.coords.longitude, stop.coords.latitude], label: String(index + 2), title: labels[index] ?? stop.address }))
      } : null)
    } catch (cause) {
      if (request.signal.aborted) return
      setError(cause instanceof Error ? cause.message : 'Не удалось рассчитать маршрут.')
    } finally {
      if (controller.current === request) { controller.current = null; setBusy(false) }
    }
  }

  const durationMinutes = result?.completion.latest ? Math.max(0, Math.round((Date.parse(result.completion.latest) - Date.parse(result.startRange.earliest)) / 60000)) : null
  const live = result?.routingProviders?.some((provider) => provider.toLowerCase().includes('tomtom'))

  return <form className="map-action-content route-builder" onSubmit={(event) => { event.preventDefault(); void calculate() }} aria-label="Построить маршрут">
    <p className="quick-order-hint route-builder-hint">Первая точка — номер машины (например <strong>125</strong>) или начальный адрес. Зажмите <GripVertical className="inline h-3.5 w-3.5" aria-hidden="true" />, чтобы поменять точки местами.</p>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={points.map((point) => point.id)} strategy={verticalListSortingStrategy}>
        <ol className="route-points">
          {points.map((point, index) => <SortablePoint key={point.id} point={point} index={index} total={points.length} match={matches[index]}
            onChange={(value) => update(point.id, value)} onRemove={() => remove(point.id)} />)}
        </ol>
      </SortableContext>
    </DndContext>
    <datalist id="route-vehicles">{vehicles.map((vehicle) => <option key={vehicle.id} value={`LKW ${vehicle.vehicleNumber}`}>{vehicle.licensePlate || vehicle.vehicleNumber}</option>)}</datalist>
    <button type="button" className="route-add-point" onClick={add} disabled={points.length >= MAX_ROUTE_POINTS}>
      <Plus className="h-4 w-4" aria-hidden="true" />{points.length >= MAX_ROUTE_POINTS ? `Максимум ${MAX_ROUTE_POINTS} точек` : 'Добавить точку'}
    </button>
    <button type="submit" className="primary-button mt-3 w-full" disabled={busy}>
      {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />}{busy ? 'Строим маршрут…' : 'Проложить маршрут'}
    </button>
    {error ? <p className="quick-order-error" role="alert"><AlertTriangle className="h-4 w-4" />{error}</p> : null}
    {result ? <div className="manual-scenario-result route-builder-result" aria-live="polite">
      <div className="route-builder-total"><strong>{Math.round(result.distanceMeters / 1000)} км</strong>{durationMinutes !== null ? <span>{formatDuration(durationMinutes)} в пути{result.stops.length > 1 ? ' со всеми точками' : ''}</span> : null}</div>
      <p className="route-builder-source">{live ? 'TomTom · с учётом пробок' : 'Без актуальных пробок'}{result.vehicleNumber ? ` · старт LKW ${result.vehicleNumber}` : ''}</p>
      <ol className="route-builder-eta">{result.stops.map((stop, index) => <li key={index}><span className="route-point-number">{index + 2}</span><span className="min-w-0 truncate">{stop.address}</span><time>{stop.latestArrival ? formatAppointment(stop.latestArrival) : '—'}</time></li>)}</ol>
      {result.warnings.map((warning, index) => <p key={index} className="quick-order-warning">{warning}</p>)}
    </div> : null}
  </form>
}

function SortablePoint({ point, index, total, match, onChange, onRemove }: {
  point: RoutePoint; index: number; total: number; match: VehicleMatch | null
  onChange: (value: string) => void; onRemove: () => void
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
      <input id={inputId} className="field-input" value={point.value} onChange={(event) => onChange(event.target.value)} placeholder={index === 0 ? 'Номер машины или адрес' : 'Город или полный адрес'}
        list={index === 0 ? 'route-vehicles' : undefined} autoComplete="off" />
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
