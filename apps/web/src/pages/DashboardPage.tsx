import { Check, ChevronDown, ChevronRight, ChevronUp, Clock3, GitFork, ListFilter, Loader2, MapPin, PackageCheck, PauseCircle, Pin, PinOff, PlayCircle, Route, Search, Truck, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

import { LazyMapPanel } from '../components/LazyMapPanel'
import { DecisionGroups } from '../components/OperationsNotifications'
import { needsAttention } from '../lib/alerts'
import { QuickOrderPanel } from '../components/QuickOrderPanel'
import { TruckCard } from '../components/TruckCard'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { useNotifications } from '../context/notifications'
import { usePolling } from '../hooks/usePolling'
import { usePopover } from '../hooks/usePopover'
import { useVehiclePosition } from '../hooks/useVehiclePosition'
import { api, type RouteOptions } from '../lib/api'
import { compareVehicles, driverHoursLine, getAttention, matchesFleetFilter, positionSource, activityNote, terminMargin, terminNeeded, vehiclePlace, vehicleStatus, type FleetFilter, type FleetSort } from '../lib/fleet-status'
import { getRoutePreview, setRoutePreview, subscribeRoutePreview } from '../lib/route-preview'
import { etaText, routeProgress, type StopState } from '../lib/route-progress'
import { currentStopOf, terminOf } from '../lib/tours'
import { classNames, formatAppointment, formatDateTime, formatDurationMinutes, formatTime, shortAddress, statusLabel, stopTypeLabel } from '../lib/format'
import type { Coordinate, CurrentPosition, DashboardVehicle, Stop } from '../types/domain'
import { zuladungState } from '../lib/zuladung'

const PIN_STORAGE_KEY = 'ops-dashboard-pinned-vehicles'
const SORT_STORAGE_KEY = 'ops-dashboard-sort'
type FleetScope = 'MINE' | 'FLEET' | 'FREE'
const scopes: Array<{ value: FleetScope; label: string }> = [
  { value: 'MINE', label: 'Мои' }, { value: 'FLEET', label: 'Весь парк' }, { value: 'FREE', label: 'Свободные' }
]
const filters: Array<{ value: FleetFilter; label: string }> = [
  { value: 'ALL', label: 'Все' }, { value: 'DECIDE', label: 'Решить' }, { value: 'MOVING', label: 'В пути' },
  { value: 'AT_STOP', label: 'На точке' }, { value: 'TERMIN', label: 'Termin' }, { value: 'NO_TERMIN', label: 'Нет Termin' }, { value: 'IDLE', label: 'Без тура' }
]
const sorts: Array<{ value: FleetSort; label: string }> = [
  { value: 'URGENCY', label: 'по срочности' }, { value: 'TERMIN', label: 'по Termin' }, { value: 'NUMBER', label: 'по номеру' }
]

export function DashboardPage() {
  const { data, error, loading, refetch } = usePolling(api.dashboard, 10_000)
  const notifications = useNotifications()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FleetFilter>('ALL')
  const [sort, setSort] = useState<FleetSort>(() => readSort())
  const [scope, setScope] = useState<FleetScope | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // The bottom panel slides down to a thin strip so the map is free; the choice is remembered in this browser.
  const [panelCollapsed, setPanelCollapsed] = useState(() => { try { return localStorage.getItem('ops-panel-collapsed') === '1' } catch { return false } })
  // While the truck card is open the panel steps aside to a strip; the dispatcher's own choice stays as it was.
  const [openWithCard, setOpenWithCard] = useState(false)
  const togglePanel = () => {
    if (cardIdRef.current) { setOpenWithCard((value) => !value); return }
    setPanelCollapsed((value) => {
      try { localStorage.setItem('ops-panel-collapsed', value ? '0' : '1') } catch { /* Storage may be unavailable. */ }
      if (!value) setDrawerOpen(false)
      return !value
    })
  }
  const cardIdRef = useRef<string | null>(null)
  const [pinned, setPinned] = useState<string[]>(() => readPinnedVehicles())
  const [actingId, setActingId] = useState<string | null>(null)
  const [actionVehicleId, setActionVehicleId] = useState<string | null>(null)
  const [actionTime, setActionTime] = useState(localDateTime())
  const [actionError, setActionError] = useState('')
  const [mapFocus, setMapFocus] = useState<Coordinate | null>(null)
  const [fitRoute, setFitRoute] = useState(0)
  const [track, setTrack] = useState<Coordinate[] | null>(null)
  // Three routes from the truck's GPS position; the grey ones can become the tour's route.
  const [routeOptions, setRouteOptions] = useState<RouteOptions | null>(null)
  const [optionsBusy, setOptionsBusy] = useState(false)
  const [optionsError, setOptionsError] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)
  const draftRoute = useSyncExternalStore(subscribeRoutePreview, getRoutePreview)
  const vehicles = useMemo(() => data?.vehicles ?? [], [data?.vehicles])
  const me = data?.me ?? null
  // Pins belong to the person: each dispatcher keeps their own.
  const pinKey = me ? `${PIN_STORAGE_KEY}:${me}` : PIN_STORAGE_KEY
  useEffect(() => { setPinned(readPinnedVehicles(pinKey)) }, [pinKey])
  // First view: own trucks when the dispatcher has some, otherwise the whole fleet.
  const hasMine = vehicles.some((row) => row.mine)
  const activeScope: FleetScope = !me ? 'FLEET' : scope ?? (hasMine ? 'MINE' : 'FLEET')
  const orderedVehicles = useMemo(() => vehicles.slice().sort((a, b) => compareVehicles(a, b, pinned, sort)), [pinned, sort, vehicles])
  const selectedId = searchParams.get('vehicleId') ?? ''
  const selected = vehicles.find((row) => row.vehicle.id === selectedId) ?? orderedVehicles[0] ?? null
  const cardId = searchParams.get('card')
  const cardRow = cardId ? vehicles.find((row) => row.vehicle.id === cardId) ?? null : null
  cardIdRef.current = cardId
  useEffect(() => { setOpenWithCard(false) }, [cardId])
  const fleet = useMemo(() => vehicles.flatMap((row) => row.mapPosition
    ? [{ id: row.vehicle.id, label: row.vehicle.vehicleNumber, ...row.mapPosition, termin: Boolean(terminOf(row.tour)), tone: vehicleStatus(row).tone }]
    : []), [vehicles])
  const position = useVehiclePosition(selected?.vehicle.id ?? '')
  const refetchPosition = position.refetch
  const notified = useMemo(() => new Set(notifications.open.map((item) => item.vehicleId)), [notifications.open])
  const stopsById = useMemo(() => new Map(vehicles.flatMap((row) => (row.tour?.stops ?? []).map((stop) => [stop.id, stop] as const))), [vehicles])

  useEffect(() => {
    if (!orderedVehicles.length || vehicles.some((row) => row.vehicle.id === selectedId)) return
    setSearchParams({ vehicleId: orderedVehicles[0].vehicle.id }, { replace: true })
  }, [orderedVehicles, selectedId, setSearchParams, vehicles])
  useEffect(() => { setDrawerOpen(false); setRouteOptions(null); setOptionsError('') }, [selected?.vehicle.id])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('ops:assistant-context', { detail: { vehicleId: selected?.vehicle.id } }))
  }, [selected?.vehicle.id])
  useEffect(() => {
    const refresh = () => { void refetch(); void refetchPosition() }
    window.addEventListener('ops:data-changed', refresh)
    return () => window.removeEventListener('ops:data-changed', refresh)
  }, [refetch, refetchPosition])
  useEffect(() => {
    // «/» jumps to the search unless the dispatcher is typing somewhere.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const scoped = orderedVehicles.filter((row) => activeScope === 'FLEET' || (activeScope === 'MINE' ? row.mine : !row.assignedTo))
  const needle = query.trim().toLocaleLowerCase('ru-RU')
  const searched = scoped.filter((row) => !needle || [row.vehicle.vehicleNumber, `lkw ${row.vehicle.vehicleNumber}`, row.vehicle.licensePlate, row.telemetry?.objectNo, row.tour?.orderNumber, shortAddress(row.from), shortAddress(row.to)]
    .some((value) => value?.toLocaleLowerCase('ru-RU').includes(needle)))
  const visibleVehicles = searched.filter((row) => matchesFleetFilter(row, filter, notified))
  const counts = Object.fromEntries(filters.map((item) => [item.value, searched.filter((row) => matchesFleetFilter(row, item.value, notified)).length])) as Record<FleetFilter, number>

  const openRouteOptions = useCallback(async (vehicleId: string) => {
    setOptionsBusy(true); setOptionsError(''); setRouteOptions(null)
    try { setRouteOptions(await api.routeOptions(vehicleId)); setFitRoute((value) => value + 1) }
    catch (cause) { setOptionsError(cause instanceof Error ? cause.message : 'Варианты маршрута не построены') }
    finally { setOptionsBusy(false) }
  }, [])
  // «Варианты маршрута» from a deviation notice opens this page with ?routes=1.
  useEffect(() => {
    if (searchParams.get('routes') !== '1' || !selectedId) return
    setSearchParams({ vehicleId: selectedId }, { replace: true })
    void openRouteOptions(selectedId)
  }, [openRouteOptions, searchParams, selectedId, setSearchParams])
  async function selectRouteOption(optionId: string) {
    if (!routeOptions) return
    const option = routeOptions.options.find((item) => item.id === optionId)
    const number = vehicles.find((row) => row.vehicle.id === routeOptions.vehicleId)?.vehicle.vehicleNumber
    if (!option || !window.confirm(`Сделать этот вариант маршрутом LKW ${number ?? ''}? ${optionLabel(option)}. ETA пересчитается от GPS.`)) return
    setOptionsBusy(true); setOptionsError('')
    try {
      await api.applyRouteOption(routeOptions.vehicleId, optionId, routeOptions.version)
      setRouteOptions(null)
      await Promise.all([refetch(), position.refetch()])
    } catch (cause) { setOptionsError(cause instanceof Error ? cause.message : 'Вариант не применён') } finally { setOptionsBusy(false) }
  }
  // The planned route stays blue; the other routes from GPS are grey with their time and distance.
  const optionAlternatives = useMemo(() => routeOptions
    ? routeOptions.options
      .filter((option) => Math.abs(option.distanceMeters - routeOptions.current.remainingDistanceMeters) > Math.max(2_000, routeOptions.current.remainingDistanceMeters * 0.02) || routeOptions.options.length <= 2)
      .map((option) => ({ id: option.id, geometry: option.geometry, label: optionLabel(option) }))
    : undefined, [routeOptions])

  // With the card open, picking another truck switches the card to it.
  function selectVehicle(vehicleId: string) { setSearchParams(cardId ? { vehicleId, card: vehicleId } : { vehicleId }, { replace: true }) }
  const openCard = useCallback((vehicleId: string) => setSearchParams({ vehicleId, card: vehicleId }, { replace: true }), [setSearchParams])
  const closeCard = useCallback(() => setSearchParams(selectedId ? { vehicleId: selectedId } : {}, { replace: true }), [selectedId, setSearchParams])
  function focusVehicle(vehicleId: string) {
    selectVehicle(vehicleId)
    const row = vehicles.find((item) => item.vehicle.id === vehicleId)
    if (row?.mapPosition) setMapFocus([...row.mapPosition.coordinate] as Coordinate)
  }
  function showRoute(vehicleId: string) {
    selectVehicle(vehicleId)
    setFitRoute((value) => value + 1)
  }
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
      if (action.type === 'MARK_LOADED' && action.stopId) await api.markLoaded(action.stopId, timestamp, action.manual)
      if (action.type === 'MARK_UNLOADED' && action.stopId) await api.markUnloaded(action.stopId, timestamp, action.manual)
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
  function changeSort(value: FleetSort) {
    setSort(value)
    try { window.localStorage.setItem(SORT_STORAGE_KEY, value) } catch { /* convenience only */ }
  }

  if (loading && !data) return <div className="dashboard-loading"><LoadingState /></div>
  if (error && !data) return <div className="dashboard-loading"><ErrorState error={error} onRetry={refetch} /></div>

  return (
    <div className="dashboard-screen">
      <aside className="fleet-rail" aria-label="Список грузовиков">
        <div className="fleet-controls">
          <div className="fleet-search-row">
            <label className="fleet-search">
              <Search className="fleet-search-icon" aria-hidden="true" />
              <span className="sr-only">Найти грузовик</span>
              <input ref={searchRef} className="fleet-search-input" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setQuery(''); event.currentTarget.blur() } }} placeholder="LKW, Auftrag или город" />
              <kbd className="fleet-search-key" aria-hidden="true">/</kbd>
            </label>
            <SortMenu sort={sort} onChange={changeSort} />
          </div>
          <div className="fleet-chips" role="group" aria-label="Фильтр автопарка">
            {filters.map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value}
              className={classNames('filter-chip', filter === item.value && 'filter-chip-active', item.value === 'DECIDE' && counts.DECIDE > 0 && 'filter-chip-alert')}
              onClick={() => setFilter(item.value)}>{item.label}<span className="filter-chip-count">{counts[item.value]}</span></button>)}
          </div>
        </div>
        <div className="fleet-scroll">
          {notifications.open.length ? <section className="decision-section" aria-label="Требует решения">
            <h2 className="fleet-section-title">Требует решения<span>{notifications.open.filter(needsAttention).length}</span></h2>
            <DecisionGroups items={notifications.open} stopOf={(item) => item.stopId ? stopsById.get(item.stopId) : null} onSelect={focusVehicle} />
          </section> : null}
          <div className="fleet-section-head">
            <h2 className="fleet-section-title">Машины</h2>
            {me ? <div className="fleet-scope" role="group" aria-label="Чьи машины показать">
              {scopes.map((item) => <button key={item.value} type="button" aria-pressed={activeScope === item.value} className={classNames('fleet-scope-button', activeScope === item.value && 'fleet-scope-button-active')} onClick={() => setScope(item.value)}>
                {item.label}<span className="fleet-scope-count">{item.value === 'MINE' ? vehicles.filter((row) => row.mine).length : item.value === 'FREE' ? vehicles.filter((row) => !row.assignedTo).length : vehicles.length}</span>
              </button>)}
            </div> : null}
            <span className="fleet-sort-label">{sorts.find((item) => item.value === sort)?.label}</span>
          </div>
          {me && activeScope === 'MINE' && !hasMine ? <p className="fleet-scope-hint">У вас пока нет машин. Откройте «Весь парк» или «Свободные» и нажмите «Взять себе» в карточке машины.</p> : null}
          <div className="fleet-list">
            {visibleVehicles.length ? visibleVehicles.map((row) => (
              <VehicleRow key={row.vehicle.id} row={row} selected={selected?.vehicle.id === row.vehicle.id} open={cardId === row.vehicle.id}
                pinned={pinned.includes(row.vehicle.id)} owner={me && activeScope !== 'MINE' && !row.mine ? (row.assignedTo ? `ведёт ${row.assignedTo.name}` : 'свободна') : null}
                busy={actingId === row.vehicle.id}
                onOpen={() => {
                  if (cardId === row.vehicle.id) { closeCard(); return }
                  openCard(row.vehicle.id)
                  // A new array each time, so a second click on the same truck flies to it again.
                  if (row.mapPosition) setMapFocus([...row.mapPosition.coordinate] as Coordinate)
                }}
                onRoute={() => showRoute(row.vehicle.id)} onPin={() => togglePin(row.vehicle.id)} onAction={() => openAction(row.vehicle.id)}
                popover={actionVehicleId === row.vehicle.id && row.currentAction ? <ActionPopover row={row} value={actionTime} onChange={setActionTime} busy={actingId === row.vehicle.id} error={actionError} onClose={() => setActionVehicleId(null)} onConfirm={() => void handleVehicleAction(row)} /> : null} />
            )) : <EmptyState label="По выбранному фильтру машины не найдены." />}
          </div>
        </div>
      </aside>
      <section className="dashboard-stage" aria-label="Карта выбранного грузовика">
        <LazyMapPanel tour={selected?.tour} position={position.data} vehicleNumber={selected?.vehicle.vehicleNumber} fleet={fleet} selectedVehicleId={selected?.vehicle.id} onSelectFleetVehicle={openCard} track={cardId ? track : null} focusCoordinate={mapFocus} previewRoute={draftRoute?.geometry} previewStops={draftRoute?.stops} previewTraffic={draftRoute?.trafficSegments} previewRoads={draftRoute?.roadSegments} previewAlternatives={draftRoute?.alternatives ?? optionAlternatives} onSelectPreviewAlternative={draftRoute?.onSelectAlternative ?? (routeOptions ? (id) => void selectRouteOption(id) : undefined)} previewKey={draftRoute?.key} fitRouteRequest={fitRoute} sourceNote height="100%" fill />
        <MapLegend />
        {!draftRoute && (routeOptions || optionsBusy || optionsError) ? <div className="map-draft-banner" role="status">
          <span>{optionsBusy ? 'Строим варианты от GPS…' : optionsError || `Варианты от GPS · ${optionAlternatives?.length ?? 0} серых · нажмите время на сером маршруте, чтобы выбрать`}</span>
          <button type="button" aria-label="Скрыть варианты маршрута" onClick={() => { setRouteOptions(null); setOptionsError('') }}><X size={16} /></button>
        </div> : null}
        {draftRoute ? <div className="map-draft-banner"><span>{draftRoute.label} · черновик</span><button type="button" aria-label="Убрать черновой маршрут с карты" onClick={() => setRoutePreview(null)}><X size={16} /></button></div> : null}
        {selected ? <VehiclePanel row={selected} position={position.data} drawerOpen={drawerOpen} onToggleDrawer={() => setDrawerOpen((value) => !value)} collapsed={cardId ? !openWithCard : panelCollapsed} onToggleCollapsed={togglePanel} onOpen={() => openCard(selected.vehicle.id)}
          onRouteOptions={() => void openRouteOptions(selected.vehicle.id)} optionsBusy={optionsBusy} onFocusStop={(stop) => setMapFocus([stop.longitude, stop.latitude] as Coordinate)} /> : null}
        <QuickOrderPanel row={selected} vehicles={vehicles.map((item) => item.vehicle)} onAddressFound={setMapFocus} onRoutePreview={setRoutePreview} onCreated={async (vehicleId) => { selectVehicle(vehicleId); await refetch() }} />
        {cardId ? <TruckCard vehicleId={cardId} row={cardRow} onClose={closeCard} onTrack={setTrack} /> : null}
        {position.error ? <button type="button" className="map-error" onClick={() => void position.refetch()}>Позиция временно недоступна · повторить</button> : null}
        {error ? <div className="dashboard-sync-warning">Данные автопарка не обновлены. Повторим автоматически.</div> : null}
      </section>
    </div>
  )
}

function SortMenu({ sort, onChange }: { sort: FleetSort; onChange: (value: FleetSort) => void }) {
  const menu = usePopover()
  return <div className="topbar-popover-anchor" ref={menu.ref}>
    <button type="button" className="fleet-filter-button" aria-expanded={menu.open} onClick={menu.toggle} aria-label="Порядок списка" title="Порядок списка"><ListFilter className="h-4 w-4" aria-hidden="true" /></button>
    {menu.open ? <div className="topbar-popover sort-popover" role="group" aria-label="Порядок списка">
      {sorts.map((item) => <button key={item.value} type="button" className="account-menu-item" aria-pressed={sort === item.value} onClick={() => { onChange(item.value); menu.close() }}>
        <Check className={classNames('h-4 w-4', sort !== item.value && 'invisible')} aria-hidden="true" /><span>{item.label}</span>
      </button>)}
    </div> : null}
  </div>
}

function VehicleRow({ row, selected, open, pinned, owner, busy, onOpen, onRoute, onPin, onAction, popover }: {
  row: DashboardVehicle; selected: boolean; open: boolean; pinned: boolean; owner: string | null; busy: boolean
  onOpen: () => void; onRoute: () => void; onPin: () => void; onAction: () => void; popover: ReactNode
}) {
  const attention = getAttention(row)
  const status = vehicleStatus(row)
  const termin = terminOf(row.tour)
  const source = positionSource(row)
  const margin = terminMargin(row)
  const place = vehiclePlace(row)
  const plate = row.telemetry?.objectNo ?? row.vehicle.licensePlate
  const dwell = status.tone === 'stop' && row.dwellMinutes ? Math.round(row.dwellMinutes) : null
  const plannedAt = row.tour ? currentStopOf(row.tour)?.plannedAt ?? null : null
  // A calm row takes the slot colour; an alarm keeps its own colour and the slot label stays visible.
  const calm = attention.tone === 'ok' || attention.tone === 'moving' || attention.tone === 'idle' || attention.tone === 'watch'
  const number = `LKW ${row.vehicle.vehicleNumber}`
  return (
    <article className={classNames('vehicle-card', termin && calm ? 'vehicle-card-termin' : `vehicle-card-${attention.tone}`, `vehicle-card-status-${status.tone}`, selected && 'vehicle-card-selected', open && 'vehicle-card-open', pinned && 'vehicle-card-pinned')}>
      <button type="button" className="vehicle-row-main" aria-current={selected ? 'true' : undefined} aria-expanded={open} onClick={onOpen}>
        <span className="vehicle-row-icon" aria-hidden="true"><Truck className="h-4 w-4" /></span>
        <span className="block min-w-0 flex-1">
          <span className="vehicle-row-title"><strong>{number}</strong>{plate ? <span className="vehicle-row-muted">{plate}</span> : null}</span>
          <span className="vehicle-row-line"><span className={`status-dot status-dot-${status.tone}`} aria-hidden="true" /><span className={`vehicle-row-status status-text-${status.tone}`}>{status.label}</span>{place ? <span className="truncate">· {place}</span> : null}</span>
          <span className="vehicle-row-meta">
            {dwell ? <span>На точке {formatDurationMinutes(dwell)}</span> : null}
            {activityNote(row) ? <span className={classNames('rest-at-stop', !row.restAtStop && 'rest-at-stop-pause')}>{activityNote(row)}</span> : null}
            {termin ? <span className="vehicle-row-termin">{termin.label}</span> : terminNeeded(row) ? <span className="termin-needed">Termin нужен</span> : null}
            {!termin && plannedAt ? <span>план {formatDateTime(plannedAt)}</span> : null}
            {row.eta && status.tone !== 'stop' ? <span>ETA {formatTime(row.eta)}{margin !== null ? <> · <span className={margin < 0 ? 'timing-late' : 'timing-ok'} title={margin < 0 ? `опоздание ${formatDurationMinutes(-margin)}` : `запас ${formatDurationMinutes(margin)}`}>+{formatDurationMinutes(Math.abs(margin))}</span></> : null}</span> : null}
            {!row.eta && status.tone === 'plan' && row.tour?.plannedStartAt ? <span>выезд {formatTime(row.tour.plannedStartAt)}</span> : null}
          </span>
          {owner ? <span className="vehicle-row-owner">{owner}</span> : null}
          {attention.rank <= 2 ? <span className="sr-only">{attention.label}: {attention.reason}</span> : null}
        </span>
      </button>
      <div className="vehicle-card-side">
        <div className="vehicle-card-actions">
          <VehicleActionButton row={row} busy={busy} onClick={onAction} />
          <button type="button" className="icon-button vehicle-route-button" onClick={onRoute} aria-label={`Маршрут ${number}`} title="Показать маршрут на карте"><Route className="h-4 w-4" aria-hidden="true" /></button>
          <button type="button" className="icon-button vehicle-pin-button" onClick={onPin} aria-label={pinned ? `Открепить ${number}` : `Закрепить ${number}`} title={pinned ? 'Открепить' : 'Закрепить сверху'}>{pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}</button>
        </div>
        <span className={`source-tag source-tag-${source.kind}`} title={source.long}>{source.short}</span>
      </div>
      {popover}
    </article>
  )
}

function VehicleActionButton({ row, busy, onClick }: { row: DashboardVehicle; busy: boolean; onClick: () => void }) {
  const action = row.currentAction
  if (!action) return null
  const Icon = busy ? Loader2
    : action.type === 'MARK_LOADED' || action.type === 'MARK_UNLOADED' ? PackageCheck
      : action.type === 'RESUME' ? PlayCircle : PauseCircle
  return (
    <button type="button" className={classNames('icon-button vehicle-action-button', action.manual && 'vehicle-action-button-manual')} onClick={onClick} disabled={busy} aria-label={action.label} title={action.manual ? `${action.label} вручную: GPS не видел машину на точке` : action.withoutGpsArrival ? `${action.label}: прибытия по GPS нет` : action.label}>
      <Icon className={classNames('h-4 w-4', busy && 'animate-spin')} aria-hidden="true" /><span>{action.label}</span>
    </button>
  )
}

function ActionPopover({ row, value, onChange, busy, error, onClose, onConfirm }: {
  row: DashboardVehicle; value: string; onChange: (value: string) => void; busy: boolean; error: string; onClose: () => void; onConfirm: () => void
}) {
  const action = row.currentAction
  if (!action) return null
  const needsTime = action.type === 'MARK_LOADED' || action.type === 'MARK_UNLOADED'
  return (
    <div className="vehicle-action-popover" role="dialog" aria-label={`${action.label} LKW ${row.vehicle.vehicleNumber}`} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-950">{action.label}</p>
          <p className="truncate text-xs text-slate-500">{shortAddress(row.currentStop ?? row.to)} · LKW {row.vehicle.vehicleNumber}</p>
        </div>
        <button type="button" className="icon-button icon-button-compact" onClick={onClose} aria-label="Закрыть"><X className="h-3.5 w-3.5" /></button>
      </div>
      {action.manual ? <p className="mt-2 text-xs text-amber-800">GPS Webfleet не видел машину на этой точке. Отметка вручную запишет прибытие и {action.label} этим временем; в истории будет пометка «без GPS-прибытия».</p>
        : action.withoutGpsArrival ? <p className="mt-2 text-xs text-amber-800">Прибытие по GPS не зафиксировано: время прибытия будет равно времени {action.type === 'MARK_LOADED' ? 'загрузки' : 'выгрузки'}.</p> : null}
      {needsTime ? <label className="mt-2 block text-xs font-medium text-slate-600">Фактическое время<input className="field-input mt-1 h-9" type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} /></label> : null}
      {error ? <p role="alert" className="mt-2 text-xs text-red-700">{error}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="secondary-button compact-button" onClick={onClose} disabled={busy}>Отмена</button>
        <button type="button" className="primary-button compact-button" onClick={onConfirm} disabled={busy || (needsTime && !value)}>{busy ? 'Сохранение…' : action.manual ? 'Подтвердить вручную' : 'Подтвердить'}</button>
      </div>
    </div>
  )
}

function MapLegend() {
  return <ul className="map-legend" aria-label="Цвета машин на карте">
    <li><span className="status-dot status-dot-ok" aria-hidden="true" />В пути</li>
    <li><span className="status-dot status-dot-stop" aria-hidden="true" />На точке</li>
    <li><span className="status-dot status-dot-late" aria-hidden="true" />Опоздание</li>
    <li><span className="status-dot status-dot-plan" aria-hidden="true" />План</li>
    <li><span className="status-dot status-dot-termin" aria-hidden="true" />Termin</li>
  </ul>
}

/** The selected truck at the bottom of the map: status, tour, Termin against ETA, distance, driver hours. */
function VehiclePanel({ row, position, drawerOpen, onToggleDrawer, collapsed, onToggleCollapsed, onOpen, onRouteOptions, optionsBusy, onFocusStop }: {
  row: DashboardVehicle; position?: CurrentPosition | null; drawerOpen: boolean; onToggleDrawer: () => void; onOpen: () => void
  collapsed: boolean; onToggleCollapsed: () => void
  onRouteOptions: () => void; optionsBusy: boolean; onFocusStop: (stop: Stop) => void
}) {
  const progress = useMemo(() => routeProgress(row.tour?.stops, row, position), [row, position])
  const status = vehicleStatus(row)
  const source = positionSource(row)
  const termin = terminOf(row.tour)
  const terminStop = termin ? progress.stops.find(({ stop }) => !stop.completedAt)?.stop ?? null : null
  const margin = terminMargin(row)
  const speed = status.tone === 'ok' && row.telemetry?.source === 'WEBFLEET' && typeof row.telemetry.speedKmh === 'number' ? ` · ${Math.round(row.telemetry.speedKmh)} км/ч` : ''
  const etaMinutes = row.eta ? Math.max(0, Math.round((new Date(row.eta).getTime() - Date.now()) / 60_000)) : null
  const nextStop = progress.currentIndex >= 0 ? progress.stops[progress.currentIndex]?.stop ?? null : row.to ?? null
  // Tachograph figures come from server memory (no Webfleet call); only while the panel is open.
  const card = usePolling(() => api.vehicleCard(row.vehicle.id), 60_000, !collapsed, `${row.vehicle.id}-${collapsed}`)
  const driver = card.data?.driver && 'drivingTimes' in card.data.driver ? card.data.driver.drivingTimes : null
  const hours = driverHoursLine(driver, row.clockSummary)
  const stageText = `${row.tour ? `Тур ${row.tour.orderNumber} · ` : ''}${progress.stops.length ? progress.summary : 'Нет активного маршрута'}`
  const timing = termin ? `${termin.label}${margin !== null ? margin < 0 ? ` · опоздание ${formatDurationMinutes(-margin)}` : ` · запас ${formatDurationMinutes(margin)}` : ''}` : row.eta ? `ETA ${formatDateTime(row.eta)}` : 'ETA нет'
  const nextText = nextStop ? `${stopTypeLabel(nextStop.type)} · ${shortAddress(nextStop)}` : 'Без тура'
  const bar = progress.stops.length ? <span className="route-stage-bar" role="progressbar" aria-label="Пройдено от тура" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.tourProgress * 100)}><span style={{ width: `${progress.tourProgress * 100}%` }} /></span> : null
  const handle = <button type="button" className="vehicle-panel-handle" onClick={onToggleCollapsed} aria-expanded={!collapsed} aria-controls="vehicle-panel-body"
    aria-label={collapsed ? 'Развернуть панель машины' : 'Свернуть панель машины'} title={collapsed ? 'Развернуть' : 'Свернуть'}>
    <span className="vehicle-panel-grip" aria-hidden="true" />{collapsed ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
  </button>

  if (collapsed) return <section className="vehicle-panel vehicle-panel-collapsed" aria-label={`LKW ${row.vehicle.vehicleNumber}`}>
    {handle}
    <button type="button" className="vehicle-panel-strip" onClick={onToggleCollapsed} aria-label={`Развернуть панель LKW ${row.vehicle.vehicleNumber}`}>
      <span className="vehicle-panel-strip-id">
        <strong>LKW {row.vehicle.vehicleNumber}</strong>
        <span className={`status-pill status-pill-${status.tone}`}><span className={`status-dot status-dot-${status.tone}`} aria-hidden="true" />{status.label}{speed}</span>
      </span>
      <span className="vehicle-panel-strip-route">
        <span className="vehicle-panel-label">{stageText}</span>
        <span className="vehicle-panel-strip-next"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />{nextText}</span>
      </span>
      <span className={classNames('vehicle-panel-strip-time', margin !== null && margin < 0 && 'timing-late')}>{timing}</span>
      {bar}
    </button>
  </section>

  return <section className={classNames('vehicle-panel', drawerOpen && 'vehicle-panel-open')} aria-label={`LKW ${row.vehicle.vehicleNumber}`}>
    {handle}
    <div id="vehicle-panel-body">
    <button type="button" className="vehicle-panel-stage route-stops-drawer-trigger" onClick={onToggleDrawer} aria-expanded={drawerOpen}>
      <span className="sr-only">Точки маршрута · {progress.stops.length}. </span>
      <span className={classNames('route-stage-summary', `route-stage-summary-${progress.stage.toLowerCase()}`)}>{stageText}</span>
      {bar}
    </button>
    {drawerOpen ? <RouteStopsTrack row={row} position={position} onFocusStop={onFocusStop} /> : null}
    <div className="vehicle-panel-bar">
      <div className="vehicle-panel-id">
        <strong>LKW {row.vehicle.vehicleNumber}</strong>
        <span className={`status-pill status-pill-${status.tone}`}><span className={`status-dot status-dot-${status.tone}`} aria-hidden="true" />{status.label}{speed}</span>
        <span className={`source-tag source-tag-${source.kind}`}>{source.kind === 'calculated' ? 'Расчётная позиция' : source.long}</span>
        {activityNote(row) ? <span className={classNames('rest-at-stop', !row.restAtStop && 'rest-at-stop-pause')}>{activityNote(row)}</span> : null}
      </div>
      <div className="vehicle-panel-next">
        <span className="vehicle-panel-label">Следующая точка</span>
        <span className="vehicle-panel-route"><MapPin className="h-4 w-4" aria-hidden="true" />{nextText}</span>
        {nextStop?.company ? <span className="vehicle-panel-note"><span>{nextStop.company}</span></span> : null}
      </div>
      <div className="vehicle-panel-metric">
        <span className="vehicle-panel-label">{termin ? `Termin ${terminStop?.type === 'LOAD' ? 'загрузки' : 'выгрузки'}` : 'ETA'}</span>
        <strong className={termin ? 'text-termin' : undefined}>{termin ? termin.label.replace(/^Termin /, '') : row.eta ? formatDateTime(row.eta) : '–'}</strong>
        <span className="vehicle-panel-note">{termin && row.eta ? <><span>ETA {formatTime(row.eta)}</span>{margin !== null ? <span className={margin < 0 ? 'timing-late' : 'timing-ok'}>{margin < 0 ? `опоздание ${formatDurationMinutes(-margin)}` : `запас ${formatDurationMinutes(margin)}`}</span> : null}</> : <span>{termin ? 'ETA нет' : 'Termin нет'}</span>}{zuladungState(row.tour) === 'OPEN' ? <span className="vehicle-panel-zuladung" title="По Auftrag перед выгрузкой возможна Zuladung, место неизвестно">без учёта Zuladung</span> : null}</span>
      </div>
      <div className="vehicle-panel-metric">
        <span className="vehicle-panel-label">Осталось</span>
        <strong>{typeof row.remainingKm === 'number' ? `≈ ${Math.round(row.remainingKm)} км` : '–'}</strong>
        <span className="vehicle-panel-note"><span>{etaMinutes !== null ? `≈ ${formatDurationMinutes(etaMinutes)} до точки` : 'время неизвестно'}</span><span>{row.etaSource === 'GPS' ? 'от GPS' : 'расчёт'}</span></span>
      </div>
      <div className="vehicle-panel-actions">
        {row.etaSource === 'GPS' ? <button type="button" className="secondary-button" onClick={onRouteOptions} disabled={optionsBusy} title="Три маршрута от GPS-позиции до точки"><GitFork className="h-4 w-4" aria-hidden="true" />Варианты</button> : null}
        <button type="button" className="secondary-button" onClick={onToggleDrawer} aria-expanded={drawerOpen} aria-label={drawerOpen ? 'Скрыть точки маршрута' : 'Показать точки маршрута'} disabled={!progress.stops.length}><Route className="h-4 w-4" aria-hidden="true" />Маршрут</button>
        <button type="button" className="primary-button" onClick={onOpen}>Открыть<ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
      </div>
    </div>
    <p className={classNames('vehicle-panel-hours', hours?.stale && 'vehicle-panel-hours-stale')} aria-label="Часы водителя">
      <Clock3 className="h-4 w-4" aria-hidden="true" />
      {hours ? <>
        {hours.parts.map((part) => <span key={part.label} className={part.warn ? 'vehicle-panel-hours-warn' : undefined}>{part.label} <strong>{part.value}</strong></span>)}
        <span className="vehicle-panel-hours-source">{hours.source}{hours.stale ? ' · устарели' : ''}</span>
      </> : <span>Часы водителя: нет данных тахографа</span>}
    </p>
    </div>
  </section>
}

function RouteStopsTrack({ row, position, onFocusStop }: { row: DashboardVehicle; position?: CurrentPosition | null; onFocusStop: (stop: Stop) => void }) {
  const progress = useMemo(() => routeProgress(row.tour?.stops, row, position), [row, position])
  const trackRef = useRef<HTMLOListElement | null>(null)
  useEffect(() => {
    // On the road, start from the previous stop so the truck on the leg stays in view.
    const items = trackRef.current?.querySelectorAll<HTMLElement>('.route-stage')
    const target = items?.[progress.stage === 'ON_ROUTE' && progress.currentIndex > 0 ? progress.currentIndex - 1 : progress.currentIndex]
    target?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }, [progress.currentIndex, progress.stage])
  const last = progress.stops.length - 1
  return <div className="route-stops-drawer-body">{progress.stops.length ? <ol ref={trackRef} className="route-stage-track" aria-label="Этапы маршрута">
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
        <StopCard stop={stop} current={index === progress.currentIndex} onFocus={() => onFocusStop(stop)} />
      </li>
    })}
  </ol> : <EmptyState label="У машины нет активного маршрута." />}</div>
}

function stopStateText(stop: Stop, state: StopState, stage: string, row: DashboardVehicle) {
  if (state === 'DONE') return `${stop.type === 'LOAD' ? 'Загружено' : 'Выгружено'} ${stop.completedAt ? formatDateTime(stop.completedAt) : ''}`.trim()
  if (state === 'AT_STOP') {
    const minutes = stop.arrivedAt ? Math.max(0, Math.floor((Date.now() - new Date(stop.arrivedAt).getTime()) / 60_000)) : null
    return `Машина здесь${minutes !== null ? ` · ${formatDurationMinutes(minutes)}` : ''}`
  }
  if (state === 'HEADING') return stage === 'ARRIVING' ? 'Прибывает · ждём GPS' : stage === 'WAITING' ? 'Первая точка' : `Едем сюда · ETA ${etaText(row.eta ?? stop.predictedEta)}`
  if (state === 'NEXT') return `Следующая${stop.predictedEta ? ` · ETA ${etaText(stop.predictedEta)}` : ''}`
  return 'Впереди'
}

function StopCard({ stop, current = false, onFocus }: { stop: Stop; current?: boolean; onFocus?: () => void }) {
  const references = stop.referenceNumbers ?? parseStopReferences(stop.referenceNumbersJson)
  // The whole card shows the stop on the map.
  return <article className={classNames('route-stop-card', current && 'route-stop-card-current', onFocus && 'route-stop-card-clickable')} onClick={onFocus}
    role={onFocus ? 'button' : undefined} tabIndex={onFocus ? 0 : undefined} aria-label={onFocus ? `Показать на карте: ${stop.sequence} · ${stopTypeLabel(stop.type)}, ${shortAddress(stop)}` : undefined}
    onKeyDown={onFocus ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onFocus() } } : undefined}><div className="flex items-center justify-between gap-2"><span className="badge border-slate-200 bg-slate-50 text-slate-700">{stop.sequence} · {stopTypeLabel(stop.type)}</span><span className="text-xs font-medium text-slate-500">{stop.status ? statusLabel(stop.status) : ''}</span></div><p className="mt-2 truncate font-semibold" title={stop.city || stop.address}>{shortAddress(stop)}</p><p className="mt-1 line-clamp-2 text-xs text-slate-500" title={stop.address}>{stop.address}</p><div className="mt-3 grid gap-1 text-xs text-slate-600"><span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> {formatAppointment(stop.appointmentAt)}</span><span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> ETA {formatDateTime(stop.predictedEta)}</span>{stop.loadingMeters ? <span>{stop.loadingMeters} LDM</span> : null}{references.length ? <span>Ref: {references.join(', ')}</span> : null}{stop.instructions ? <span className="line-clamp-2">{stop.instructions}</span> : null}</div></article>
}

function parseStopReferences(value?: string | null): string[] { if (!value) return []; try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [] } catch { return [] } }

function optionLabel(option: { durationSeconds: number; distanceMeters: number; mainRoads: string[] }) {
  return `${formatDurationMinutes(Math.round(option.durationSeconds / 60))} · ${Math.round(option.distanceMeters / 1000)} км${option.mainRoads.length ? ` · ${option.mainRoads.join(', ')}` : ''}`
}

function localDateTime(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function readSort(): FleetSort { try { const value = window.localStorage.getItem(SORT_STORAGE_KEY); return value === 'NUMBER' || value === 'TERMIN' ? value : 'URGENCY' } catch { return 'URGENCY' } }
function readPinnedVehicles(key = PIN_STORAGE_KEY): string[] { try { const parsed = JSON.parse(window.localStorage.getItem(key) ?? '[]'); return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [] } catch { return [] } }
