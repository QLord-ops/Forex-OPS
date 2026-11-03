import { CalendarClock, ArrowUpRight, Check, ChevronDown, AlertTriangle, Clock3, Loader2, MapPin, PackageCheck, PauseCircle, Pin, PinOff, PlayCircle, Search, Truck, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { LazyMapPanel } from '../components/LazyMapPanel'
import { QuickOrderPanel } from '../components/QuickOrderPanel'
import { TruckCard } from '../components/TruckCard'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { useVehiclePosition } from '../hooks/useVehiclePosition'
import { api } from '../lib/api'
import { getRoutePreview, setRoutePreview, subscribeRoutePreview } from '../lib/route-preview'
import { etaText, routeProgress, type StopState } from '../lib/route-progress'
import { terminOf } from '../lib/tours'
import { classNames, formatAppointment, formatDateTime, formatDelay, formatDurationMinutes, formatKm, formatTime, shortAddress, statusLabel, stopTypeLabel } from '../lib/format'
import type { Coordinate, CurrentPosition, DashboardVehicle, Stop } from '../types/domain'

const PIN_STORAGE_KEY = 'ops-dashboard-pinned-vehicles'
type FleetFilter = 'ALL' | 'ATTENTION' | 'MOVING' | 'AT_STOP' | 'TERMIN' | 'IDLE'
type FleetScope = 'MINE' | 'FLEET' | 'FREE'
const scopes: Array<{ value: FleetScope; label: string }> = [
  { value: 'MINE', label: 'Мои' }, { value: 'FLEET', label: 'Весь парк' }, { value: 'FREE', label: 'Свободные' }
]
type AttentionTone = 'dwell' | 'critical' | 'action' | 'watch' | 'moving' | 'ok' | 'idle'
const filters: Array<{ value: FleetFilter; label: string }> = [
  { value: 'ALL', label: 'Все' }, { value: 'ATTENTION', label: 'Контроль' },
  { value: 'MOVING', label: 'В пути' }, { value: 'AT_STOP', label: 'На точке' }, { value: 'TERMIN', label: 'Термин' },
  { value: 'IDLE', label: 'Без тура' }
]

export function DashboardPage() {
  const { data, error, loading, refetch } = usePolling(api.dashboard, 10_000)
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FleetFilter>('ALL')
  const [scope, setScope] = useState<FleetScope | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [hudOpen, setHudOpen] = useState(false)
  const [pinned, setPinned] = useState<string[]>(() => readPinnedVehicles())
  const [actingId, setActingId] = useState<string | null>(null)
  const [actionVehicleId, setActionVehicleId] = useState<string | null>(null)
  const [actionTime, setActionTime] = useState(localDateTime())
  const [actionError, setActionError] = useState('')
  const [mapFocus, setMapFocus] = useState<Coordinate | null>(null)
  const [track, setTrack] = useState<Coordinate[] | null>(null)
  const draftRoute = useSyncExternalStore(subscribeRoutePreview, getRoutePreview)
  const vehicles = useMemo(() => data?.vehicles ?? [], [data?.vehicles])
  const me = data?.me ?? null
  // Pins belong to the person: each dispatcher keeps their own.
  const pinKey = me ? `${PIN_STORAGE_KEY}:${me}` : PIN_STORAGE_KEY
  useEffect(() => { setPinned(readPinnedVehicles(pinKey)) }, [pinKey])
  // First view: own trucks when the dispatcher has some, otherwise the whole fleet.
  const hasMine = vehicles.some((row) => row.mine)
  const activeScope: FleetScope = !me ? 'FLEET' : scope ?? (hasMine ? 'MINE' : 'FLEET')
  const orderedVehicles = useMemo(() => vehicles.slice().sort((a, b) => compareVehicles(a, b, pinned)), [pinned, vehicles])
  const selectedId = searchParams.get('vehicleId') ?? ''
  const selected = vehicles.find((row) => row.vehicle.id === selectedId) ?? orderedVehicles[0] ?? null
  const cardId = searchParams.get('card')
  const cardRow = cardId ? vehicles.find((row) => row.vehicle.id === cardId) ?? null : null
  const fleet = useMemo(() => vehicles.flatMap((row) => row.mapPosition ? [{ id: row.vehicle.id, label: row.vehicle.vehicleNumber, ...row.mapPosition, termin: Boolean(terminOf(row.tour)) }] : []), [vehicles])
  const position = useVehiclePosition(selected?.vehicle.id ?? '')
  const refetchPosition = position.refetch

  useEffect(() => {
    if (!orderedVehicles.length || vehicles.some((row) => row.vehicle.id === selectedId)) return
    setSearchParams({ vehicleId: orderedVehicles[0].vehicle.id }, { replace: true })
  }, [orderedVehicles, selectedId, setSearchParams, vehicles])
  useEffect(() => { setDrawerOpen(false); setHudOpen(false) }, [selected?.vehicle.id])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('ops:assistant-context', { detail: { vehicleId: selected?.vehicle.id } }))
  }, [selected?.vehicle.id])
  useEffect(() => {
    const refresh = () => { void refetch(); void refetchPosition() }
    window.addEventListener('ops:data-changed', refresh)
    return () => window.removeEventListener('ops:data-changed', refresh)
  }, [refetch, refetchPosition])

  const visibleVehicles = orderedVehicles.filter((row) => {
    const needle = query.trim().toLocaleLowerCase('ru-RU')
    const matchesQuery = !needle || [row.vehicle.vehicleNumber, row.vehicle.licensePlate, row.tour?.orderNumber, shortAddress(row.from), shortAddress(row.to)]
      .some((value) => value?.toLocaleLowerCase('ru-RU').includes(needle))
    const inScope = activeScope === 'FLEET' || (activeScope === 'MINE' ? row.mine : !row.assignedTo)
    return matchesQuery && inScope && matchesFleetFilter(row, filter)
  })

  // With the card open, picking another truck switches the card to it.
  function selectVehicle(vehicleId: string) { setSearchParams(cardId ? { vehicleId, card: vehicleId } : { vehicleId }, { replace: true }) }
  const openCard = useCallback((vehicleId: string) => setSearchParams({ vehicleId, card: vehicleId }, { replace: true }), [setSearchParams])
  const closeCard = useCallback(() => setSearchParams(selectedId ? { vehicleId: selectedId } : {}, { replace: true }), [selectedId, setSearchParams])
  function openAction(vehicleId: string) {
    setActionVehicleId((current) => current === vehicleId ? null : vehicleId)
    setActionTime(localDateTime())
    setActionError('')
  }
  async function handleVehicleAction(row: DashboardVehicle) {
    if (!row.currentAction || actingId) return
    setActingId(row.vehicle.id)
    setActionError('')
    try {
      const action = row.currentAction
      const timestamp = new Date(actionTime).toISOString()
      if (action.type === 'MARK_LOADED' && action.stopId) await api.markLoaded(action.stopId, timestamp)
      if (action.type === 'MARK_UNLOADED' && action.stopId) await api.markUnloaded(action.stopId, timestamp)
      if (action.type === 'MANUAL_STOP') await api.manualStop(row.vehicle.id, row.operationVersion ?? 0)
      if (action.type === 'RESUME') await api.resumeVehicle(row.vehicle.id, row.operationVersion ?? 0)
      await refetch()
      if (selected?.vehicle.id === row.vehicle.id) await position.refetch()
      setActionVehicleId(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Не удалось выполнить действие')
    } finally {
      setActingId(null)
    }
  }
  function togglePin(vehicleId: string) {
    setPinned((current) => {
      const next = current.includes(vehicleId) ? current.filter((id) => id !== vehicleId) : [...current, vehicleId]
      try { window.localStorage.setItem(pinKey, JSON.stringify(next)) } catch { /* convenience only */ }
      return next
    })
  }

  if (loading && !data) return <div className="dashboard-loading"><LoadingState /></div>
  if (error && !data) return <div className="dashboard-loading"><ErrorState error={error} onRetry={refetch} /></div>

  return (
    <div className="dashboard-screen">
      <aside className="fleet-rail" aria-label="Список грузовиков">
        <div className="fleet-controls">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <span className="sr-only">Найти грузовик</span>
            <input className="field-input pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="LKW, Auftrag или город" />
          </label>
          {me ? <div className="fleet-scope" role="group" aria-label="Чьи машины показать">
            {scopes.map((item) => <button key={item.value} type="button" aria-pressed={activeScope === item.value} className={classNames('fleet-scope-button', activeScope === item.value && 'fleet-scope-button-active')} onClick={() => setScope(item.value)}>
              {item.label}<span className="fleet-scope-count">{item.value === 'MINE' ? vehicles.filter((row) => row.mine).length : item.value === 'FREE' ? vehicles.filter((row) => !row.assignedTo).length : vehicles.length}</span>
            </button>)}
          </div> : null}
          {me && activeScope === 'MINE' && !hasMine ? <p className="fleet-scope-hint">У вас пока нет машин. Откройте «Весь парк» или «Свободные» и нажмите «Взять себе» в карточке машины.</p> : null}
          <div className="mt-2 flex gap-1 overflow-x-auto pb-1" aria-label="Фильтр автопарка">
            {filters.map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value} className={classNames('filter-chip', filter === item.value && 'filter-chip-active')} onClick={() => setFilter(item.value)}>{item.label}</button>)}
          </div>
        </div>
        <div className="fleet-list">
          {visibleVehicles.length ? visibleVehicles.map((row) => {
            const attention = getAttention(row)
            const isSelected = selected?.vehicle.id === row.vehicle.id
            const isPinned = pinned.includes(row.vehicle.id)
            const termin = terminOf(row.tour)
            // A calm row takes the slot colour; an alarm keeps its own colour and the slot label stays visible.
            const calm = attention.tone === 'ok' || attention.tone === 'moving' || attention.tone === 'idle'
            return (
              <article key={row.vehicle.id} className={classNames('vehicle-card', termin && calm ? 'vehicle-card-termin' : `vehicle-card-${attention.tone}`, isSelected && 'vehicle-card-selected', cardId === row.vehicle.id && 'vehicle-card-open')}>
                <button type="button" className="vehicle-row-main" aria-current={isSelected ? 'true' : undefined} aria-expanded={cardId === row.vehicle.id}
                  onClick={() => {
                    if (cardId === row.vehicle.id) { closeCard(); return }
                    openCard(row.vehicle.id)
                    // A new array each time, so a second click on the same truck flies to it again.
                    if (row.mapPosition) setMapFocus([...row.mapPosition.coordinate] as Coordinate)
                  }}>
                  <VehicleRowIcon row={row} />
                  <span className="block min-w-0 flex-1">
                    <span className="vehicle-row-title">
                      <strong>{row.telemetry?.objectNo ?? `LKW ${row.vehicle.vehicleNumber}`}</strong>
                      {row.telemetry?.objectName ? <span> – {row.telemetry.objectName}</span> : null}
                      {row.telemetry?.objectNo ? <span className="vehicle-row-muted">LKW {row.vehicle.vehicleNumber}</span> : row.vehicle.licensePlate ? <span className="vehicle-row-muted">{row.vehicle.licensePlate}</span> : null}
                    </span>
                    <span className={classNames('vehicle-row-line', row.telemetry?.stale && 'vehicle-row-stale')}>{vehicleRowLine(row)}</span>
                    {termin ? <span className="vehicle-row-termin"><CalendarClock className="h-3 w-3" aria-hidden="true" />{termin.label}</span> : null}
                    {me && activeScope !== 'MINE' && !row.mine ? <span className="vehicle-row-owner">{row.assignedTo ? `ведёт ${row.assignedTo.name}` : 'свободна'}</span> : null}
                  </span>
                  {attention.tone === 'critical' || attention.tone === 'dwell' || attention.tone === 'action' || attention.tone === 'watch'
                    ? <span className={classNames('vehicle-row-alert', `vehicle-row-alert-${attention.tone}`)} title={`${attention.label}: ${attention.reason}`}><AlertTriangle className="h-4 w-4" aria-hidden="true" /><span className="sr-only">{attention.label}: {attention.reason}</span></span>
                    : null}
                </button>
                <div className="vehicle-card-actions">
                  <VehicleActionButton row={row} busy={actingId === row.vehicle.id} onClick={() => openAction(row.vehicle.id)} />
                  <button type="button" className="icon-button" onClick={() => togglePin(row.vehicle.id)} aria-label={isPinned ? `Открепить LKW ${row.vehicle.vehicleNumber}` : `Закрепить LKW ${row.vehicle.vehicleNumber}`} title={isPinned ? 'Открепить' : 'Закрепить'}>{isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}</button>
                </div>
                {actionVehicleId === row.vehicle.id && row.currentAction ? <ActionPopover row={row} value={actionTime} onChange={setActionTime} busy={actingId === row.vehicle.id} error={actionError} onClose={() => setActionVehicleId(null)} onConfirm={() => void handleVehicleAction(row)} /> : null}
              </article>
            )
          }) : <EmptyState label="По выбранному фильтру машины не найдены." />}
        </div>
      </aside>
      <section className="dashboard-stage" aria-label="Карта выбранного грузовика">
        <LazyMapPanel tour={selected?.tour} position={position.data} vehicleNumber={selected?.vehicle.vehicleNumber} fleet={fleet} selectedVehicleId={selected?.vehicle.id} onSelectFleetVehicle={openCard} track={cardId ? track : null} focusCoordinate={mapFocus} previewRoute={draftRoute?.geometry} previewStops={draftRoute?.stops} previewTraffic={draftRoute?.trafficSegments} previewAlternatives={draftRoute?.alternatives} onSelectPreviewAlternative={draftRoute?.onSelectAlternative} previewKey={draftRoute?.key} height="100%" fill />
        {draftRoute ? <div className="map-draft-banner"><span>{draftRoute.label} · черновик</span><button type="button" aria-label="Убрать черновой маршрут с карты" onClick={() => setRoutePreview(null)}><X size={16} /></button></div> : null}
        {selected ? <><VehicleMapHud row={selected} open={hudOpen} onToggle={() => setHudOpen((value) => !value)} /><RouteStopsDrawer row={selected} position={position.data} open={drawerOpen} onToggle={() => setDrawerOpen((value) => !value)} /></> : null}
        <QuickOrderPanel row={selected} vehicles={vehicles.map((item) => item.vehicle)} onAddressFound={setMapFocus} onRoutePreview={setRoutePreview} onCreated={async (vehicleId) => { selectVehicle(vehicleId); await refetch() }} />
        {cardId ? <TruckCard vehicleId={cardId} row={cardRow} onClose={closeCard} onTrack={setTrack} /> : null}
        {position.error ? <button type="button" className="map-error" onClick={() => void position.refetch()}>Позиция временно недоступна · повторить</button> : null}
        {error ? <div className="dashboard-sync-warning">Данные автопарка не обновлены. Повторим автоматически.</div> : null}
      </section>
    </div>
  )
}

/** Truck icon with a dot for the position source, like a telematics list: green fresh GPS, amber stale, grey calculated. */
function VehicleRowIcon({ row }: { row: DashboardVehicle }) {
  const telemetry = row.telemetry
  const source = telemetry?.source === 'WEBFLEET' ? (telemetry.stale ? 'stale' : 'live') : 'calculated'
  return <span className="vehicle-row-icon" aria-hidden="true"><Truck className="h-4 w-4" /><span className={`vehicle-row-dot vehicle-row-dot-${source}`} /></span>
}

/** "(32 км/ч) 10:25, Halberstädter Straße, 39365 Harbke" — speed, GPS time and address; calculated trucks show status and next stop. */
function vehicleRowLine(row: DashboardVehicle) {
  const telemetry = row.telemetry
  if (telemetry?.source === 'WEBFLEET' && telemetry.checkedAt) {
    const time = formatTime(telemetry.checkedAt)
    const moving = telemetry.standstill === false
    const arrow = moving && typeof telemetry.courseDeg === 'number'
      ? <span className="vehicle-row-arrow" style={{ transform: `rotate(${telemetry.courseDeg}deg)` }} aria-hidden="true" /> : null
    const motion = moving ? `(${Math.round(telemetry.speedKmh ?? 0)} км/ч)` : telemetry.standstill ? 'стоит' : ''
    return <>{arrow}<span className="truncate">{[motion, time].filter(Boolean).join(' ')}{telemetry.address ? `, ${telemetry.address}` : ''}{telemetry.stale ? ' · устарело' : ''}</span></>
  }
  return <span className="truncate">{statusLabel(row.statusText)} · расчёт{row.to ? ` · ${shortAddress(row.to)}, ${stopTypeLabel(row.to.type)}` : ''}</span>
}

function VehicleActionButton({ row, busy, onClick }: { row: DashboardVehicle; busy: boolean; onClick: () => void }) {
  const action = row.currentAction
  if (!action) return null
  const Icon = busy ? Loader2
    : action.type === 'MARK_LOADED' || action.type === 'MARK_UNLOADED' ? PackageCheck
      : action.type === 'RESUME' ? PlayCircle : PauseCircle
  return (
    <button type="button" className="icon-button vehicle-action-button" onClick={onClick} disabled={busy} aria-label={action.label} title={action.withoutGpsArrival ? `${action.label}: прибытия по GPS нет` : action.label}>
      <Icon className={classNames('h-4 w-4', busy && 'animate-spin')} aria-hidden="true" /><span>{action.label}</span>
    </button>
  )
}

function ActionPopover({
  row,
  value,
  onChange,
  busy,
  error,
  onClose,
  onConfirm
}: {
  row: DashboardVehicle
  value: string
  onChange: (value: string) => void
  busy: boolean
  error: string
  onClose: () => void
  onConfirm: () => void
}) {
  const action = row.currentAction
  if (!action) return null
  const needsTime = action.type === 'MARK_LOADED' || action.type === 'MARK_UNLOADED'
  return (
    <div className="vehicle-action-popover" role="dialog" aria-label={`${action.label} LKW ${row.vehicle.vehicleNumber}`} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-black text-slate-950">{action.label}</p>
          <p className="truncate text-xs font-semibold text-slate-500">{shortAddress(row.currentStop ?? row.to)} · LKW {row.vehicle.vehicleNumber}</p>
        </div>
        <button type="button" className="icon-button icon-button-compact" onClick={onClose} aria-label="Закрыть"><X className="h-3.5 w-3.5" /></button>
      </div>
      {action.withoutGpsArrival ? <p className="mt-2 text-xs font-semibold text-amber-800">Прибытие по GPS не зафиксировано: время прибытия будет равно времени {action.type === 'MARK_LOADED' ? 'загрузки' : 'выгрузки'}.</p> : null}
      {needsTime ? <label className="mt-2 block text-xs font-bold text-slate-600">Фактическое время<input className="field-input mt-1 h-9" type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} /></label> : null}
      {error ? <p role="alert" className="mt-2 text-xs font-semibold text-red-700">{error}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="secondary-button compact-button" onClick={onClose} disabled={busy}>Отмена</button>
        <button type="button" className="primary-button compact-button" onClick={onConfirm} disabled={busy || (needsTime && !value)}>{busy ? 'Сохранение…' : 'Подтвердить'}</button>
      </div>
    </div>
  )
}

function VehicleMapHud({ row, open, onToggle }: { row: DashboardVehicle; open: boolean; onToggle: () => void }) {
  const attention = getAttention(row)
  return <div className={classNames('vehicle-map-hud', open && 'vehicle-map-hud-open')}>
    <button type="button" className="vehicle-map-hud-trigger" onClick={onToggle} aria-expanded={open} aria-label="Показать информацию о грузовике">
      <span className="hud-vehicle">LKW {row.vehicle.vehicleNumber}</span><HudMetric label="ETA" value={formatDateTime(row.eta)} /><HudMetric label="Осталось" value={formatKm(row.remainingKm)} /><HudMetric label="Опоздание" value={formatDelay(row.delayMinutes)} alert={(row.delayMinutes ?? 0) > 0} /><ChevronDown className="hud-chevron h-5 w-5" aria-hidden="true" />
    </button>
    <div className="vehicle-map-hud-details"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className={classNames('attention-pill', `attention-pill-${attention.tone}`)}>{attention.label}</span><span className="text-sm font-semibold text-slate-600">{statusLabel(row.statusText)}</span></div><p className="mt-1 truncate text-sm font-bold text-slate-900">{row.tour?.orderNumber ?? 'Нет активного Auftrag'} · {shortAddress(row.from)} → {shortAddress(row.to)}</p></div><Link className="primary-button shrink-0" to={`/vehicles/${row.vehicle.id}`}>Открыть LKW <ArrowUpRight className="h-4 w-4" aria-hidden="true" /></Link></div>
  </div>
}

function RouteStopsDrawer({ row, position, open, onToggle }: { row: DashboardVehicle; position?: CurrentPosition | null; open: boolean; onToggle: () => void }) {
  const progress = useMemo(() => routeProgress(row.tour?.stops, row, position), [row, position])
  const trackRef = useRef<HTMLOListElement | null>(null)
  useEffect(() => {
    if (!open) return
    // On the road, start from the previous stop so the truck on the leg stays in view.
    const items = trackRef.current?.querySelectorAll<HTMLElement>('.route-stage')
    const target = items?.[progress.stage === 'ON_ROUTE' && progress.currentIndex > 0 ? progress.currentIndex - 1 : progress.currentIndex]
    target?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }, [open, progress.currentIndex, progress.stage])
  const last = progress.stops.length - 1
  return <div className={classNames('route-stops-drawer', open && 'route-stops-drawer-open')}>
    <button type="button" className="route-stops-drawer-trigger" onClick={onToggle} aria-expanded={open}>
      <span className="drawer-handle" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-sm font-black text-slate-950">Точки маршрута · {progress.stops.length}</span>
        <span className={classNames('route-stage-summary', `route-stage-summary-${progress.stage.toLowerCase()}`)}>{progress.summary}</span>
        {progress.stops.length ? <span className="route-stage-bar" role="progressbar" aria-label="Пройдено от тура" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.tourProgress * 100)}><span style={{ width: `${progress.tourProgress * 100}%` }} /></span> : null}
      </span>
      <ChevronDown className="drawer-chevron h-5 w-5 shrink-0" aria-hidden="true" />
    </button>
    <div className="route-stops-drawer-body">{progress.stops.length ? <ol ref={trackRef} className="route-stage-track" aria-label="Этапы маршрута">
      {progress.stops.map(({ stop, state }, index) => {
        // The line after stop i leads to stop i+1; it fills as the truck drives that leg.
        const fill = index < progress.currentIndex - 1 ? 1 : index === progress.currentIndex - 1 ? progress.legProgress : 0
        const truckOnLine = index === progress.currentIndex - 1 && progress.stage === 'ON_ROUTE'
        return <li key={stop.id} className={classNames('route-stage', `route-stage-${state.toLowerCase()}`)} data-current={index === progress.currentIndex} aria-label={`Точка ${stop.sequence}, ${shortAddress(stop)}: ${stopStateText(stop, state, progress.stage, row)}`}>
          <div className="route-stage-rail" aria-hidden="true">
            <span className="route-stage-dot">{state === 'DONE' ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : stop.sequence}</span>
            {index < last ? <span className="route-stage-line"><span className="route-stage-line-fill" style={{ width: `${fill * 100}%` }} />{truckOnLine ? <span className="route-stage-truck" style={{ left: `${fill * 100}%` }}><Truck className="h-3.5 w-3.5" /></span> : null}</span> : null}
          </div>
          <p className="route-stage-state">{stopStateText(stop, state, progress.stage, row)}</p>
          <StopCard stop={stop} current={index === progress.currentIndex} />
        </li>
      })}
    </ol> : <EmptyState label="У машины нет активного маршрута." />}</div>
  </div>
}

function stopStateText(stop: Stop, state: StopState, stage: string, row: DashboardVehicle) {
  if (state === 'DONE') return `${stop.type === 'LOAD' ? 'Загружено' : 'Выгружено'} ${stop.completedAt ? formatDateTime(stop.completedAt) : ''}`.trim()
  if (state === 'AT_STOP') {
    const minutes = stop.arrivedAt ? Math.max(0, Math.floor((Date.now() - new Date(stop.arrivedAt).getTime()) / 60_000)) : null
    return `Машина здесь${minutes !== null ? ` · ${formatDurationMinutes(minutes)}` : ''}`
  }
  if (state === 'HEADING') return stage === 'ARRIVING' ? 'Прибывает · подтвердите' : stage === 'WAITING' ? 'Первая точка' : `Едем сюда · ETA ${etaText(row.eta ?? stop.predictedEta)}`
  if (state === 'NEXT') return `Следующая${stop.predictedEta ? ` · ETA ${etaText(stop.predictedEta)}` : ''}`
  return 'Впереди'
}

function StopCard({ stop, current = false }: { stop: Stop; current?: boolean }) {
  const references = stop.referenceNumbers ?? parseStopReferences(stop.referenceNumbersJson)
  return <article className={classNames('route-stop-card', current && 'route-stop-card-current')}><div className="flex items-center justify-between gap-2"><span className="badge border-slate-200 bg-slate-50 text-slate-700">{stop.sequence} · {stopTypeLabel(stop.type)}</span><span className="text-xs font-bold text-slate-500">{stop.status ? statusLabel(stop.status) : ''}</span></div><p className="mt-2 truncate font-black" title={stop.city || stop.address}>{shortAddress(stop)}</p><p className="mt-1 line-clamp-2 text-xs text-slate-500" title={stop.address}>{stop.address}</p><div className="mt-3 grid gap-1 text-xs font-semibold text-slate-600"><span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> {formatAppointment(stop.appointmentAt)}</span><span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> ETA {formatDateTime(stop.predictedEta)}</span>{stop.loadingMeters ? <span>{stop.loadingMeters} LDM</span> : null}{references.length ? <span>Ref: {references.join(', ')}</span> : null}{stop.instructions ? <span className="line-clamp-2">{stop.instructions}</span> : null}</div></article>
}

function parseStopReferences(value?: string | null): string[] { if (!value) return []; try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [] } catch { return [] } }

function HudMetric({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) { return <span className="hud-metric"><span>{label}</span><strong className={alert ? 'text-rose-300' : ''}>{value}</strong></span> }

function localDateTime(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function compareVehicles(a: DashboardVehicle, b: DashboardVehicle, pinned: string[]) {
  // Pinned trucks stay on top whatever their state; inside each group the most urgent come first.
  const pinDifference = Number(pinned.includes(b.vehicle.id)) - Number(pinned.includes(a.vehicle.id))
  if (pinDifference) return pinDifference
  const rankDifference = getAttention(a).rank - getAttention(b).rank
  if (rankDifference) return rankDifference
  const delayDifference = (b.delayMinutes ?? 0) - (a.delayMinutes ?? 0)
  return delayDifference || a.vehicle.vehicleNumber.localeCompare(b.vehicle.vehicleNumber, 'ru', { numeric: true })
}

function getAttention(row: DashboardVehicle): { rank: number; tone: AttentionTone; label: string; reason: string } {
  const breakdown = row.issues?.find(issue => issue.kind === 'BREAKDOWN')
  if (breakdown) return { rank: -1, tone: 'critical', label: 'Ремонт', reason: `${breakdown.description} · ${breakdown.expectedResolvedAt ? `ETA условная, ремонт до ${formatDateTime(breakdown.expectedResolvedAt)}` : 'Срок ремонта и ETA неизвестны'}` }
  const dwellMinutes = getDwellMinutes(row)
  const dwellSeverity = row.dwellSeverity ?? (dwellMinutes > 120 ? 'CRITICAL' : dwellMinutes > 60 ? 'WARNING' : 'NONE')
  if (dwellSeverity === 'CRITICAL') return { rank: 0, tone: 'dwell', label: 'Долгая стоянка', reason: `На точке ${formatDurationMinutes(dwellMinutes)}` }
  if (row.risk === 'RED' || (row.delayMinutes ?? 0) > 0) return { rank: 1, tone: 'critical', label: 'Критично', reason: `Опоздание ${formatDelay(row.delayMinutes)}` }
  if (dwellSeverity === 'WARNING') return { rank: 2, tone: 'action', label: 'Стоянка', reason: `На точке ${formatDurationMinutes(dwellMinutes)}` }
  if (row.risk === 'ORANGE' || row.statusText === 'ARRIVED') return { rank: 2, tone: 'action', label: 'Нужно действие', reason: row.statusText === 'ARRIVED' ? 'Ожидается подтверждение операции на точке' : 'Высокий риск нарушения срока' }
  if (row.risk === 'YELLOW') return { rank: 3, tone: 'watch', label: 'Контроль', reason: 'Небольшой запас до термина' }
  if (row.statusText === 'MOVING') return { rank: 4, tone: 'moving', label: 'В пути', reason: 'Движется по расчётному маршруту' }
  if (row.risk === 'GREEN') return { rank: 5, tone: 'ok', label: 'По плану', reason: 'Отклонений по текущему расчёту нет' }
  return { rank: 6, tone: 'idle', label: 'Без контроля', reason: row.tour ? statusLabel(row.statusText) : 'Нет активного тура' }
}

function getDwellMinutes(row: DashboardVehicle) {
  if (typeof row.dwellMinutes === 'number') return row.dwellMinutes > 0 ? Math.max(1, Math.ceil(row.dwellMinutes)) : 0
  const stop = row.currentStop ?? row.tour?.stops?.find((item) => item.arrivedAt && !item.completedAt)
  return stop?.arrivedAt ? Math.max(1, Math.ceil((Date.now() - new Date(stop.arrivedAt).getTime()) / 60_000)) : 0
}

function matchesFleetFilter(row: DashboardVehicle, filter: FleetFilter) {
  const attention = getAttention(row)
  if (filter === 'ALL') return true
  if (filter === 'ATTENTION') return attention.rank <= 3
  if (filter === 'MOVING') return row.statusText === 'MOVING'
  if (filter === 'TERMIN') return Boolean(terminOf(row.tour))
  if (filter === 'AT_STOP') return ['ARRIVED', 'WAITING', 'MANUAL_STOP'].includes(row.statusText) || getDwellMinutes(row) > 0
  return !row.tour || ['IDLE', 'NO_ACTIVE_ROUTE'].includes(row.statusText)
}

function readPinnedVehicles(key = PIN_STORAGE_KEY): string[] { try { const parsed = JSON.parse(window.localStorage.getItem(key) ?? '[]'); return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [] } catch { return [] } }
