import { Check, ChevronDown, ChevronUp, Clock3, GitFork, Loader2, MapPin, PackageCheck, PauseCircle, Pin, PinOff, PlayCircle, Route, Search, SlidersHorizontal, Truck, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

import { isPhone, useIsPhone } from '../hooks/useIsPhone'

import { LazyMapPanel } from '../components/LazyMapPanel'
import { DecisionGroups } from '../components/OperationsNotifications'
import { needsAttention } from '../lib/alerts'
import { AUFTRAG_DROP_EVENT, QuickOrderPanel, type AuftragDraftSummary } from '../components/QuickOrderPanel'
import { previewRouteScenario } from '../lib/assistant-api'
import type { RouteScenario } from '../types/assistant'
import { CoverPanel } from '../components/CoverPanel'
import { TruckCard } from '../components/TruckCard'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { useNotifications } from '../context/notifications'
import { usePolling } from '../hooks/usePolling'
import { usePopover } from '../hooks/usePopover'
import { useVehiclePosition } from '../hooks/useVehiclePosition'
import { api, type RouteOptions } from '../lib/api'
import { compareVehicles, driverHoursLine, etaPlanLine, getAttention, liveSpeed, manuallyStopped, matchesFleetFilter, notStarted, plannedStart, positionSource, runsLate, activityNote, terminMargin, terminNeeded, terminToday, vehiclePlace, vehicleStatus, type FleetFilter, type FleetSort } from '../lib/fleet-status'
import { CustomerNoticeButton } from '../components/CustomerNotice'
import { noticeDue, noticeLine } from '../lib/customer-notice'
import type { AlertNotification } from '../lib/alerts'
import { getRoutePreview, setRoutePreview, subscribeRoutePreview } from '../lib/route-preview'
import { etaText, routeProgress, type StopState } from '../lib/route-progress'
import { currentStopOf, terminOf } from '../lib/tours'
import { stopEta, stopTerminLabel } from '../lib/stop-times'
import { classNames, formatDateTime, formatDurationMinutes, formatTime, placeName, shortAddress, statusLabel, stopTypeLabel } from '../lib/format'
import type { Coordinate, CurrentPosition, DashboardVehicle, DrivingTimes, Stop } from '../types/domain'
import { zuladungState } from '../lib/zuladung'
import { customerColor } from '../lib/customers'
import { fleetOnMap, inScope, useFleetScope, type FleetScope } from '../lib/fleet-scope'
import '../components/customers.css'
import './dashboard-redesign.css'

const PIN_STORAGE_KEY = 'ops-dashboard-pinned-vehicles'
const SORT_STORAGE_KEY = 'ops-dashboard-sort'
const FILTERS_STORAGE_KEY = 'ops-list-filters'
const scopes: Array<{ value: FleetScope; label: string }> = [
  { value: 'MINE', label: 'Мои' }, { value: 'FLEET', label: 'Весь парк' }, { value: 'FREE', label: 'Свободные' }
]
const filters: Array<{ value: FleetFilter; label: string }> = [
  { value: 'ALL', label: 'Все' }, { value: 'DECIDE', label: 'Решить' }, { value: 'LATE', label: 'Опаздывают' }, { value: 'MOVING', label: 'В пути' },
  { value: 'AT_STOP', label: 'На точке' }, { value: 'PLANNED', label: 'Запланированы' }, { value: 'TERMIN', label: 'Termin' }, { value: 'NO_TERMIN', label: 'Нет Termin' }, { value: 'IDLE', label: 'Без тура' }
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
  const [customerFilter, setCustomerFilter] = useState<string | null>(null)
  // The chips and the cover buttons are folded behind «Фильтры»: the figures over the map already filter the list
  // (owner, 19.11: «всё мешает, информация уже есть сверху»). The choice is remembered in this browser.
  const [filtersOpen, setFiltersOpen] = useState(() => { try { return localStorage.getItem(FILTERS_STORAGE_KEY) === '1' } catch { return false } })
  const toggleFilters = () => setFiltersOpen((value) => {
    try { localStorage.setItem(FILTERS_STORAGE_KEY, value ? '0' : '1') } catch { /* convenience only */ }
    return !value
  })
  const [sort, setSort] = useState<FleetSort>(() => readSort())
  const { viewer, scope, setScope } = useFleetScope()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // The bottom panel slides down to a thin strip so the map is free; the choice is remembered in this browser.
  // Collapsed by default on a phone, where the map is small; the choice is remembered either way.
  const [panelCollapsed, setPanelCollapsed] = useState(() => { try { const stored = localStorage.getItem('ops-panel-collapsed'); return stored === null ? isPhone() : stored === '1' } catch { return false } })
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
  const [actionPlace, setActionPlace] = useState<'list' | 'panel'>('list')
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
  const [auftrag, setAuftrag] = useState<AuftragDraftSummary | null>(null)
  const draftRoute = useSyncExternalStore(subscribeRoutePreview, getRoutePreview)
  const vehicles = useMemo(() => data?.vehicles ?? [], [data?.vehicles])
  const me = data?.me ?? null
  // Pins belong to the person: each dispatcher keeps their own.
  const pinKey = me ? `${PIN_STORAGE_KEY}:${me}` : PIN_STORAGE_KEY
  useEffect(() => { setPinned(readPinnedVehicles(pinKey)) }, [pinKey])
  // A dispatcher starts with their own trucks, an admin with the whole fleet; the map follows the same choice.
  const hasMine = vehicles.some((row) => row.mine)
  const activeScope: FleetScope = me ? scope : 'FLEET'
  const orderedVehicles = useMemo(() => vehicles.slice().sort((a, b) => compareVehicles(a, b, pinned, sort)), [pinned, sort, vehicles])
  const selectedId = searchParams.get('vehicleId') ?? ''
  // Nothing picked yet: the first truck of the scope, never a colleague's truck for a dispatcher without their own.
  const firstInScope = orderedVehicles.find((row) => inScope(row, activeScope)) ?? null
  const selected = vehicles.find((row) => row.vehicle.id === selectedId) ?? firstInScope
  const cardId = searchParams.get('card')
  // Phone: the truck list and the map are two tabs (?view=map); every change of the selection keeps the tab.
  const view = searchParams.get('view') === 'map' ? 'map' : 'list'
  const phone = useIsPhone()
  const cardRow = cardId ? vehicles.find((row) => row.vehicle.id === cardId) ?? null : null
  cardIdRef.current = cardId
  useEffect(() => { setOpenWithCard(false) }, [cardId])
  const shownId = selected?.vehicle.id ?? null
  const fleet = useMemo(() => fleetOnMap(vehicles, activeScope, shownId).flatMap((row) => row.mapPosition
    ? [{ id: row.vehicle.id, label: row.vehicle.vehicleNumber, ...row.mapPosition, termin: Boolean(terminOf(row.tour)), tone: vehicleStatus(row).tone, ...mapLabel(row) }]
    : []), [activeScope, shownId, vehicles])
  const position = useVehiclePosition(selected?.vehicle.id ?? '')
  const refetchPosition = position.refetch
  const notified = useMemo(() => new Set(notifications.open.map((item) => item.vehicleId)), [notifications.open])
  const unreadOf = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of notifications.open) if (item.vehicleId && needsAttention(item)) counts.set(item.vehicleId, (counts.get(item.vehicleId) ?? 0) + 1)
    return counts
  }, [notifications.open])
  const stopsById = useMemo(() => new Map(vehicles.flatMap((row) => (row.tour?.stops ?? []).map((stop) => [stop.id, stop] as const))), [vehicles])

  useEffect(() => {
    if (!firstInScope || vehicles.some((row) => row.vehicle.id === selectedId)) return
    setSearchParams(withView({ vehicleId: firstInScope.vehicle.id }, view), { replace: true })
  }, [firstInScope, selectedId, setSearchParams, vehicles, view])
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

  const customerChips = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; slug: string; color: string | null; count: number }>()
    for (const row of vehicles) if (row.customer) {
      const entry = seen.get(row.customer.id) ?? { ...row.customer, count: 0 }
      entry.count += 1
      seen.set(row.customer.id, entry)
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [vehicles])
  const scoped = orderedVehicles.filter((row) => inScope(row, activeScope))
    .filter((row) => !customerFilter || row.customer?.id === customerFilter)
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
    // On a phone the options are on the map tab.
    setSearchParams(withView({ vehicleId: selectedId }, phone ? 'map' : view), { replace: true })
    void openRouteOptions(selectedId)
  }, [openRouteOptions, phone, searchParams, selectedId, setSearchParams, view])
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
  function selectVehicle(vehicleId: string) { setSearchParams(withView(cardId ? { vehicleId, card: vehicleId } : { vehicleId }, view), { replace: true }) }
  const openCard = useCallback((vehicleId: string) => setSearchParams(withView({ vehicleId, card: vehicleId }, view), { replace: true }), [setSearchParams, view])
  const closeCard = useCallback(() => setSearchParams(withView(selectedId ? { vehicleId: selectedId } : {}, view), { replace: true }), [selectedId, setSearchParams, view])
  function focusVehicle(vehicleId: string) {
    selectVehicle(vehicleId)
    const row = vehicles.find((item) => item.vehicle.id === vehicleId)
    if (row?.mapPosition) setMapFocus([...row.mapPosition.coordinate] as Coordinate)
  }
  function showRoute(vehicleId: string) {
    selectVehicle(vehicleId)
    setFitRoute((value) => value + 1)
  }
  function openAction(vehicleId: string, place: 'list' | 'panel' = 'list') {
    setActionPlace(place)
    setActionVehicleId((current) => current === vehicleId && actionPlace === place ? null : vehicleId)
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

  const decisionCount = notifications.open.filter(needsAttention).length
  const activeFilters = [
    ...(filter !== 'ALL' ? [{ label: filters.find((item) => item.value === filter)?.label ?? 'Фильтр', clear: () => setFilter('ALL') }] : []),
    ...(customerFilter ? [{ label: customerChips.find((item) => item.id === customerFilter)?.name ?? 'Заказчик', clear: () => setCustomerFilter(null) }] : [])
  ]
  const popoverFor = (row: DashboardVehicle, place: 'list' | 'panel') => actionVehicleId === row.vehicle.id && actionPlace === place && row.currentAction
    ? <ActionPopover row={row} value={actionTime} onChange={setActionTime} busy={actingId === row.vehicle.id} error={actionError} onClose={() => setActionVehicleId(null)} onConfirm={() => void handleVehicleAction(row)} />
    : null
  return (
    <div className={`dashboard-screen dashboard-view-${view}`}>
      <aside className="fleet-rail" aria-label="Список грузовиков">
        <div className="fleet-controls">
          <div className="fleet-head">
            <h2 className="fleet-head-title">Машины <span className="fleet-head-count">{visibleVehicles.length} из {vehicles.length}</span></h2>
            <SortMenu sort={sort} onChange={changeSort} />
          </div>
          {me ? <div className="fleet-scope" role="group" aria-label="Чьи машины показать">
            {scopes.map((item) => <button key={item.value} type="button" aria-pressed={activeScope === item.value} className={classNames('fleet-scope-button', activeScope === item.value && 'fleet-scope-button-active')} onClick={() => setScope(item.value)}
              title={item.value === 'MINE' && viewer.role === 'admin' ? 'Скрыть все линии, кроме своих: на карте, в списке и в уведомлениях' : undefined}>
              {item.value === 'MINE' && viewer.role === 'admin' ? 'Мои линии' : item.label}<span className="fleet-scope-count">{item.value === 'MINE' ? vehicles.filter((row) => row.mine).length : item.value === 'FREE' ? vehicles.filter((row) => !row.assignedTo).length : vehicles.length}</span>
            </button>)}
          </div> : null}
          {me && activeScope === 'MINE' && !hasMine ? <p className="fleet-scope-hint">У вас пока нет машин. Откройте «Весь парк» или «Свободные» и нажмите «Взять себе» в карточке машины.</p> : null}
          <div className="fleet-search-row">
            <label className="fleet-search">
              <Search className="fleet-search-icon" aria-hidden="true" />
              <span className="sr-only">Найти грузовик</span>
              <input ref={searchRef} className="fleet-search-input" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setQuery(''); event.currentTarget.blur() } }} placeholder="LKW, Auftrag, город" />
              <kbd className="fleet-search-key" aria-hidden="true">/</kbd>
            </label>
            <button type="button" className="fleet-filters-toggle" aria-expanded={filtersOpen} aria-controls="fleet-more" onClick={toggleFilters}
              aria-label="Фильтры и подмена" title={filtersOpen ? 'Скрыть фильтры и подмену' : 'Фильтры по статусу и заказчику, подмена коллеги'}>
              <SlidersHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />{activeFilters.length ? <span className="fleet-filters-count" aria-label={`включено: ${activeFilters.length}`}>{activeFilters.length}</span> : null}
            </button>
          </div>
          {!filtersOpen && activeFilters.length ? <div className="fleet-active" role="group" aria-label="Включённые фильтры">
            {activeFilters.map((item) => <button key={item.label} type="button" className="filter-chip filter-chip-active" onClick={item.clear} aria-label={`Снять фильтр «${item.label}»`}>{item.label}<X className="h-3.5 w-3.5" aria-hidden="true" /></button>)}
          </div> : null}
          <div id="fleet-more" className="fleet-more" hidden={!filtersOpen}>
            <div className="fleet-chips" role="group" aria-label="Фильтр автопарка">
              {filters.filter((item) => item.value === 'ALL' || item.value === filter || counts[item.value] > 0).map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value}
                className={classNames('filter-chip', filter === item.value && 'filter-chip-active', item.value === 'DECIDE' && counts.DECIDE > 0 && 'filter-chip-alert')}
                onClick={() => setFilter(item.value)}>{item.label}<span className="filter-chip-count">{counts[item.value]}</span></button>)}
            </div>
            {customerChips.length > 1 ? <div className="fleet-customers" role="group" aria-label="Заказчик">
              <button type="button" aria-pressed={!customerFilter} className={classNames('filter-chip', !customerFilter && 'filter-chip-active')} onClick={() => setCustomerFilter(null)}>Все заказчики</button>
              {customerChips.map((item) => <button key={item.id} type="button" aria-pressed={customerFilter === item.id} className={classNames('filter-chip', customerFilter === item.id && 'filter-chip-active')} onClick={() => setCustomerFilter(customerFilter === item.id ? null : item.id)}>
                <span className="customer-swatch" style={{ background: customerColor(item), width: 8, height: 8 }} aria-hidden="true" />{item.name}<span className="filter-chip-count">{item.count}</span>
              </button>)}
            </div> : null}
          </div>
          <CoverPanel actions={filtersOpen} />
        </div>
        <div className="fleet-scroll">
          <div className="fleet-list">
            {visibleVehicles.length ? visibleVehicles.map((row) => (
              <VehicleRow key={row.vehicle.id} row={row} selected={selected?.vehicle.id === row.vehicle.id} open={cardId === row.vehicle.id}
                pinned={pinned.includes(row.vehicle.id)} unread={unreadOf.get(row.vehicle.id) ?? 0} owner={!me ? null : row.cover ? (row.mine ? `за ${row.cover.absent.name}` : `ведёт ${row.cover.by.name} за ${row.cover.absent.name}`)
                  : activeScope !== 'MINE' && !row.mine ? (row.assignedTo ? `ведёт ${row.assignedTo.name}` : 'свободна') : null}
                busy={actingId === row.vehicle.id}
                onOpen={() => {
                  if (cardId === row.vehicle.id) { closeCard(); return }
                  openCard(row.vehicle.id)
                  // A new array each time, so a second click on the same truck flies to it again.
                  if (row.mapPosition) setMapFocus([...row.mapPosition.coordinate] as Coordinate)
                }}
                onRoute={() => showRoute(row.vehicle.id)} onPin={() => togglePin(row.vehicle.id)} onAction={() => openAction(row.vehicle.id)}
                popover={popoverFor(row, 'list')} />
            )) : <EmptyState label="По выбранному фильтру машины не найдены." />}
          </div>
        </div>
      </aside>
      <section className="dashboard-stage" aria-label="Карта выбранного грузовика"
        // A file dropped anywhere on the map opens the Auftrag review; no frame or banner while dragging (owner, 18.11).
        onDragOver={(event) => { if (!phone && event.dataTransfer.types.includes('Files')) event.preventDefault() }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          window.dispatchEvent(new CustomEvent(AUFTRAG_DROP_EVENT, { detail: Array.from(event.dataTransfer.files) }))
        }}>
        <LazyMapPanel tour={selected?.tour} position={position.data} vehicleNumber={selected?.vehicle.vehicleNumber} fleet={fleet} selectedVehicleId={selected?.vehicle.id} onSelectFleetVehicle={openCard} track={cardId ? track : null} focusCoordinate={mapFocus} previewRoute={draftRoute?.geometry} previewStops={draftRoute?.stops ?? auftragStops(auftrag)} previewTraffic={draftRoute?.trafficSegments} previewRoads={draftRoute?.roadSegments} previewAlternatives={draftRoute?.alternatives ?? optionAlternatives} onSelectPreviewAlternative={draftRoute?.onSelectAlternative ?? (routeOptions ? (id) => void selectRouteOption(id) : undefined)} previewKey={draftRoute?.key} fitRouteRequest={fitRoute} sourceNote height="100%" fill />
        <FleetSummary rows={scoped} decisions={decisionCount} filter={filter} onFilter={setFilter} />
        {auftrag && !phone ? <AuftragCheck draft={auftrag} vehicles={vehicles} /> : null}
        {notifications.open.length && !phone && !auftrag ? <DecisionStack items={notifications.open} stopOf={(item) => item.stopId ? stopsById.get(item.stopId) : null} onSelect={focusVehicle} rowOf={(vehicleId) => vehicles.find((row) => row.vehicle.id === vehicleId)} /> : null}
        <MapLegend />
        {!draftRoute && (routeOptions || optionsBusy || optionsError) ? <div className="map-draft-banner" role="status">
          <span>{optionsBusy ? 'Строим варианты от GPS…' : optionsError || `Варианты от GPS · ${optionAlternatives?.length ?? 0} серых · нажмите время на сером маршруте, чтобы выбрать`}</span>
          <button type="button" aria-label="Скрыть варианты маршрута" onClick={() => { setRouteOptions(null); setOptionsError('') }}><X size={16} /></button>
        </div> : null}
        {draftRoute ? <div className="map-draft-banner"><span>{draftRoute.label} · черновик</span><button type="button" aria-label="Убрать черновой маршрут с карты" onClick={() => setRoutePreview(null)}><X size={16} /></button></div> : null}
        {selected ? <VehiclePanel row={selected} position={position.data} drawerOpen={drawerOpen} onToggleDrawer={() => setDrawerOpen((value) => !value)} collapsed={cardId ? !openWithCard : panelCollapsed} onToggleCollapsed={togglePanel} onOpen={() => openCard(selected.vehicle.id)}
          onRouteOptions={() => void openRouteOptions(selected.vehicle.id)} optionsBusy={optionsBusy} onFocusStop={(stop) => setMapFocus([stop.longitude, stop.latitude] as Coordinate)}
          action={<VehicleActionButton row={selected} busy={actingId === selected.vehicle.id} onClick={() => openAction(selected.vehicle.id, 'panel')} record />} actionPopover={popoverFor(selected, 'panel')} jam={jamOf(notifications.open, selected.vehicle.id)} /> : null}
        <QuickOrderPanel row={selected} vehicles={vehicles.map((item) => item.vehicle)} onAddressFound={setMapFocus} onRoutePreview={setRoutePreview} onCreated={async (vehicleId) => { selectVehicle(vehicleId); await refetch() }} onDraftChange={setAuftrag} />
        {cardId && !phone ? <TruckCard vehicleId={cardId} row={cardRow} onClose={closeCard} onTrack={setTrack} /> : null}
        {position.error ? <button type="button" className="map-error" onClick={() => void position.refetch()}>Позиция временно недоступна · повторить</button> : null}
        {error ? <div className="dashboard-sync-warning">Данные автопарка не обновлены. Повторим автоматически.</div> : null}
      </section>
      {cardId && phone ? <TruckCard vehicleId={cardId} row={cardRow} onClose={closeCard} onTrack={setTrack} sheet /> : null}
    </div>
  )
}

/** The shift at a glance above the map: each figure filters the list where a filter exists. */
function FleetSummary({ rows, decisions, filter, onFilter }: { rows: DashboardVehicle[]; decisions: number; filter: FleetFilter; onFilter: (value: FleetFilter) => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer) }, [])
  const late = rows.filter((row) => runsLate(row)).length
  const atStop = rows.filter((row) => vehicleStatus(row).tone === 'stop').length
  const termin = rows.filter((row) => terminToday(row)).length
  const longest = rows.reduce((max, row) => vehicleStatus(row).tone === 'stop' && row.dwellMinutes ? Math.max(max, row.dwellMinutes) : max, 0)
  const items: Array<{ value: string; label: string; tone?: string; filter?: FleetFilter; title?: string }> = [
    { value: String(rows.length), label: 'машин', filter: 'ALL' },
    { value: String(late), label: 'опаздывает', tone: late ? 'late' : undefined, filter: 'LATE', title: 'ETA позже Termin или задержка в пути' },
    { value: String(atStop), label: 'на точке', tone: atStop ? 'stop' : undefined, filter: 'AT_STOP' },
    { value: String(termin), label: 'Termin сегодня', tone: termin ? 'termin' : undefined, filter: 'TERMIN' },
    { value: String(decisions), label: decisions === 1 ? 'вопрос' : 'вопросов', tone: decisions ? 'late' : undefined, filter: 'DECIDE' },
    { value: longest ? formatDurationMinutes(Math.round(longest)) : '–', label: 'дольше всех на точке', tone: longest >= 120 ? 'late' : longest ? 'stop' : undefined }
  ]
  return <div className="fleet-summary" role="group" aria-label="Смена: сводка">
    {items.map((item) => item.filter
      ? <button key={item.label} type="button" className={classNames('fleet-summary-item', item.tone && `fleet-summary-${item.tone}`)} aria-pressed={filter === item.filter} onClick={() => onFilter(item.filter!)} title={item.title}><strong>{item.value}</strong><span>{item.label}</span></button>
      : <span key={item.label} className={classNames('fleet-summary-item', item.tone && `fleet-summary-${item.tone}`)} title={item.title}><strong>{item.value}</strong><span>{item.label}</span></span>)}
    <time className="fleet-summary-clock" dateTime={new Date(now).toISOString()}>{new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(now).replace(',', ' ·')}</time>
  </div>
}

/** «Требует решения» over the map: two questions at once, the rest behind «открыть все». */
function DecisionStack({ items, stopOf, onSelect, rowOf }: { items: AlertNotification[]; stopOf: (item: AlertNotification) => Stop | null | undefined; onSelect: (vehicleId: string) => void; rowOf: (vehicleId: string) => DashboardVehicle | undefined }) {
  const [expanded, setExpanded] = useState(false)
  const decisions = items.filter(needsAttention)
  const info = items.length - decisions.length
  const hidden = Math.max(0, decisions.length - DECISIONS_SHOWN)
  // «Для сведения» is folded anyway; the stack shortens only when more than two questions wait.
  const compact = !expanded && hidden > 0
  return <section className={classNames('decision-stack-panel', expanded && 'decision-stack-panel-open')} aria-label="Требует решения">
    <h2 className="decision-stack-head">Требует решения<span>{decisions.length}</span>
      {expanded ? <button type="button" className="decision-stack-toggle" onClick={() => setExpanded(false)}>Свернуть</button>
        // Shown only where the stack is folded to its heading: a laptop with the truck card open.
        : <button type="button" className="decision-stack-toggle decision-stack-show" onClick={() => setExpanded(true)}>Показать</button>}
    </h2>
    <DecisionGroups items={compact ? decisions.slice(0, DECISIONS_SHOWN) : items} stopOf={stopOf} onSelect={onSelect} extraOf={(item) => {
      // A jam that makes the truck late or a long wait at the gate: the letter to the customer is one click from the notice.
      const row = (item.type === 'TRAFFIC_DELAY' || item.type === 'LONG_DWELL') && !item.resolved ? rowOf(item.vehicleId) : undefined
      return row && noticeDue(row) ? <CustomerNoticeButton row={row} className="decision-button" /> : null
    }} />
    {compact ? <button type="button" className="decision-stack-more" onClick={() => setExpanded(true)}>
      {[hidden ? `ещё ${hidden} ${hidden === 1 ? 'вопрос' : 'вопроса'}` : null, info ? `${info} для сведения` : null].filter(Boolean).join(' · ')}<span>открыть все</span>
    </button> : null}
  </section>
}
const DECISIONS_SHOWN = 2

/** The stops of an Auftrag under review, where the address is already known: on the map, numbered, no line drawn. */
function auftragStops(draft: AuftragDraftSummary | null) {
  if (!draft) return undefined
  const stops = draft.stops.flatMap((stop, index) => stop.coords
    ? [{ coordinate: [stop.coords.longitude, stop.coords.latitude] as Coordinate, label: String(index + 1), title: `${index + 1} · ${stop.type === 'LOAD' ? 'BELADEN' : 'ENTLADEN'} ${placeName(stop) || stop.address}` }]
    : [])
  return stops.length ? stops : undefined
}

/**
 * «Если взять LKW …» (design 13, owner 18.11.2026): the truck picked in the review, when it is free, and — on request,
 * because it asks the router — whether it makes every Termin of the new Auftrag. The route then shows on the map.
 */
function AuftragCheck({ draft, vehicles }: { draft: AuftragDraftSummary; vehicles: DashboardVehicle[] }) {
  const row = vehicles.find((item) => item.vehicle.id === draft.vehicleId) ?? null
  const [result, setResult] = useState<{ key: string; scenario: RouteScenario } | null>(null)
  const [state, setState] = useState<{ busy: boolean; error: string }>({ busy: false, error: '' })
  const key = JSON.stringify([draft.vehicleId, draft.stops.map((stop) => [stop.address, stop.coords?.latitude, stop.appointmentAt])])
  const scenario = result?.key === key ? result.scenario : null
  useEffect(() => () => { setRoutePreview(null) }, [])
  const ready = Boolean(row) && draft.stops.length > 0 && draft.stops.every((stop) => stop.address.trim())
  // Free after the last stop: its latest arrival and the stay there (an hour and a half between one and two).
  const lastStop = row?.tour ? (row.tour.stops ?? []).filter((stop) => !stop.completedAt).at(-1) : null
  const lastEta = lastStop?.arrivedAt ?? lastStop?.predictedEta ?? null
  const busyUntil = lastEta ? new Date(Math.max(Date.now(), new Date(lastEta).getTime() + 90 * 60_000)).toISOString() : null
  async function check() {
    if (!row || !ready) return
    setState({ busy: true, error: '' })
    try {
      const next = await previewRouteScenario({ vehicleId: row.vehicle.id, startMode: 'AFTER_CURRENT_TOUR', includeQueueImpact: false,
        stops: draft.stops.map((stop) => ({ address: stop.address, type: stop.type, ...(stop.coords ? { coords: stop.coords } : {}), appointmentAt: stop.appointmentAt })) })
      setResult({ key, scenario: next })
      if (next.geometry.length >= 2) setRoutePreview({ geometry: next.geometry, trafficSegments: next.trafficSegments, label: `Черновик Auftrag ${draft.orderNumber || ''} · LKW ${row.vehicle.vehicleNumber}`.replace('  ', ' '), key: `auftrag-${Date.now()}`,
        stops: next.stops.map((stop, index) => ({ coordinate: [stop.coords.longitude, stop.coords.latitude] as Coordinate, label: String(index + 1), title: `${index + 1} · ${stop.type === 'LOAD' ? 'BELADEN' : 'ENTLADEN'} ${(draft.stops[index] && placeName(draft.stops[index])) || stop.address}` })) })
      setState({ busy: false, error: '' })
    } catch (cause) { setState({ busy: false, error: cause instanceof Error ? cause.message : 'Маршрут не рассчитан.' }) }
  }
  return <section className="auftrag-check" aria-label="Черновик Auftrag">
    <p className="auftrag-check-kicker">Черновик Auftrag{draft.orderNumber ? ` ${draft.orderNumber}` : ''} · {draft.stops.length} {draft.stops.length === 1 ? 'точка' : draft.stops.length < 5 ? 'точки' : 'точек'} · ещё не создан</p>
    {row ? <>
      <h2 className="auftrag-check-title">Если взять LKW {row.vehicle.vehicleNumber}</h2>
      <p className="auftrag-check-line">{row.tour ? `занята: тур ${row.tour.orderNumber}${busyUntil ? `, свободна ≈ ${formatDateTime(busyUntil)}` : ''}` : 'свободна сейчас'}{row.mapPosition ? ` · ${vehiclePlace(row) || 'позиция известна'}` : ''}</p>
      {scenario ? <ul className="auftrag-check-stops">
        {scenario.stops.map((stop, index) => {
          const termin = draft.stops[index]?.appointmentAt
          const eta = stop.latestArrival ?? stop.earliestArrival
          const margin = termin && eta ? Math.round((Date.parse(termin) - Date.parse(eta)) / 60_000) : null
          return <li key={index}><b>{index + 1}</b><span>{draft.stops[index] ? placeName(draft.stops[index]) || draft.stops[index].address : stop.address}</span>
            <span>{eta ? `ETA ${formatDateTime(eta)}` : 'ETA нет'}{margin !== null ? <em className={margin < 0 ? 'timing-late' : 'timing-ok'}>{margin < 0 ? ` · опоздание ${formatDurationMinutes(-margin)}` : ` · запас ${formatDurationMinutes(margin)}`}</em> : null}</span></li>
        })}
      </ul> : null}
      {scenario ? <p className="auftrag-check-line">{Math.round(scenario.distanceMeters / 1000)} км · старт ≈ {formatDateTime(scenario.startRange.earliest)}{scenario.requiresDailyRest ? ' · нужен суточный отдых' : ''}{scenario.preliminary ? ' · предварительно' : ''}</p> : null}
      {state.error ? <p role="alert" className="auftrag-check-error">{state.error}</p> : null}
      <button type="button" className="secondary-button compact-button" onClick={() => void check()} disabled={state.busy || !ready}>{state.busy ? 'Считаем…' : scenario ? 'Пересчитать' : 'Проверить маршрут и Termin'}</button>
    </> : <p className="auftrag-check-line">Выберите машину в проверке Auftrag: здесь будет видно, когда она свободна и успеет ли к Termin.</p>}
  </section>
}

function SortMenu({ sort, onChange }: { sort: FleetSort; onChange: (value: FleetSort) => void }) {
  const menu = usePopover()
  return <div className="popover-anchor" ref={menu.ref}>
    <button type="button" className="fleet-sort-button" aria-expanded={menu.open} onClick={menu.toggle} title="Порядок списка"><span className="sr-only">Порядок списка: </span>{sorts.find((item) => item.value === sort)?.label}<ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /></button>
    {menu.open ? <div className="popover-menu sort-popover" role="group" aria-label="Порядок списка">
      {sorts.map((item) => <button key={item.value} type="button" className="account-menu-item" aria-pressed={sort === item.value} onClick={() => { onChange(item.value); menu.close() }}>
        <Check className={classNames('h-4 w-4', sort !== item.value && 'invisible')} aria-hidden="true" /><span>{item.label}</span>
      </button>)}
    </div> : null}
  </div>
}

function VehicleRow({ row, selected, open, pinned, owner, busy, unread, onOpen, onRoute, onPin, onAction, popover }: {
  row: DashboardVehicle; selected: boolean; open: boolean; pinned: boolean; owner: string | null; busy: boolean; unread: number
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
  const clock = cardClock(row, status.tone, dwell)
  const speed = status.tone !== 'stop' && liveSpeed(row) !== null ? `${liveSpeed(row)} км/ч` : null
  const driving = typeof row.clockSummary?.remainingDrivingMinutes === 'number' ? `вождение ещё ${formatClock(row.clockSummary.remainingDrivingMinutes)}` : null
  const km = row.tour && typeof row.remainingKm === 'number' && row.remainingKm >= 1 && status.tone !== 'stop' ? `осталось ${Math.round(row.remainingKm)} км` : null
  return (
    <article className={classNames('vehicle-card', termin && calm ? 'vehicle-card-termin' : `vehicle-card-${attention.tone}`, `vehicle-card-status-${status.tone}`, selected && 'vehicle-card-selected', open && 'vehicle-card-open', pinned && 'vehicle-card-pinned')}>
      <button type="button" className="vehicle-row-main" aria-current={selected ? 'true' : undefined} aria-expanded={open} onClick={onOpen}>
        <span className="vehicle-row-head">
          <span className="vehicle-row-title"><strong>{number}</strong>{unread ? <span className="vehicle-row-unread" aria-label={`открытых вопросов: ${unread}`}>{unread}</span> : null}{plate && plate !== row.vehicle.vehicleNumber ? <span className="vehicle-row-muted">{plate}</span> : null}</span>
          {clock ? <span className="vehicle-row-clock"><small>{clock.label}</small>{clock.value}</span> : null}
        </span>
        <span className="vehicle-row-line"><span className={`status-dot status-dot-${status.tone}`} aria-hidden="true" /><span className={`vehicle-row-status status-text-${status.tone}`}>{status.label}</span>{place ? <span className="truncate" title={place}>· {place}</span> : null}</span>
        <span className="vehicle-row-meta">
          {margin !== null && row.eta && status.tone !== 'stop' ? <span className={classNames('vehicle-row-chip', margin < 0 ? 'vehicle-row-chip-late' : 'vehicle-row-chip-ok')}>{margin < 0 ? `опоздание ${formatDurationMinutes(-margin)}` : `запас ${formatDurationMinutes(margin)}`}</span> : null}
          {dwell ? <span className="vehicle-row-chip vehicle-row-chip-stop">на точке {formatDurationMinutes(dwell)}</span> : null}
          {termin ? <span className="vehicle-row-termin">{termin.label}</span> : terminNeeded(row) ? <span className="termin-needed">Termin нужен</span> : null}
          {!termin && plannedAt ? <span className="vehicle-row-chip">план {formatDateTime(plannedAt)}</span> : null}
          {row.customer ? <span className="vehicle-row-customer"><span className="customer-swatch" style={{ background: customerColor(row.customer) }} aria-hidden="true" />{row.customer.name}{row.line ? ` · ${row.line.name}` : ''}</span> : null}
          {owner ? <span className="vehicle-row-owner" title={owner}>{owner}</span> : null}
        </span>
        {/* The way left sits here so the line above keeps room for firm and town (owner, 18.11). */}
        {speed || driving || km ? <span className="vehicle-row-info">{[km, speed, driving].filter(Boolean).join(' · ')}</span> : null}
        {attention.rank <= 2 ? <span className="sr-only">{attention.label}: {attention.reason}</span> : null}
      </button>
      {/* Its own line across the card: next to the GPS chip the tachograph line had no room (09.11). */}
      {activityNote(row) ? <p className="vehicle-card-activity"><span className={classNames('rest-at-stop', !row.restAtStop && 'rest-at-stop-pause')}>{activityNote(row)}</span></p> : null}
      <div className="vehicle-card-side">
        <span className="vehicle-card-tags">
          <span className={`source-tag source-tag-${source.kind}`} title={source.long}>{source.short}</span>
        </span>
        <div className="vehicle-card-actions">
          <VehicleActionButton row={row} busy={busy} onClick={onAction} />
          <button type="button" className="icon-button vehicle-route-button" onClick={onRoute} aria-label={`Маршрут ${number}`} title="Показать маршрут на карте"><Route className="h-4 w-4" aria-hidden="true" /></button>
          <button type="button" className="icon-button vehicle-pin-button" onClick={onPin} aria-label={pinned ? `Открепить ${number}` : `Закрепить ${number}`} title={pinned ? 'Открепить' : 'Закрепить сверху'}>{pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}</button>
        </div>
      </div>
      {popover}
    </article>
  )
}

/** The big time of a card: ETA on the road, since when at the stop, the planned start before the tour. */
function cardClock(row: DashboardVehicle, tone: string, dwell: number | null): { label: string; value: string } | null {
  if (tone === 'stop') {
    const since = manuallyStopped(row) ? row.statusStartedAt ?? null : row.currentStop?.arrivedAt ?? (dwell ? new Date(Date.now() - dwell * 60_000).toISOString() : null)
    return since ? { label: 'с', value: formatTime(since) } : null
  }
  // A tour that has not begun has no arrival to forecast: its first stop's time is what the dispatcher plans by.
  const start = tone === 'plan' ? plannedStart(row) : null
  if (start) return { label: 'начало', value: etaText(start).replace(',', '') }
  if (row.eta) return { label: 'ETA', value: formatTime(row.eta) }
  return null
}

function formatClock(minutes: number) {
  const total = Math.max(0, Math.round(minutes))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function VehicleActionButton({ row, busy, onClick, record = false }: { row: DashboardVehicle; busy: boolean; onClick: () => void; record?: boolean }) {
  const action = row.currentAction
  if (!action) return null
  const Icon = busy ? Loader2
    : action.type === 'MARK_LOADED' || action.type === 'MARK_UNLOADED' ? PackageCheck
      : action.type === 'RESUME' ? PlayCircle : PauseCircle
  return (
    <button type="button" className={classNames(record ? 'primary-button vehicle-panel-record' : 'icon-button vehicle-action-button', action.manual && 'vehicle-action-button-manual')} onClick={onClick} disabled={busy} aria-label={record && (action.type === 'MARK_LOADED' || action.type === 'MARK_UNLOADED') ? `Записать ${action.label}` : action.label} title={action.manual ? `${action.label} вручную: GPS не видел машину на точке` : action.withoutGpsArrival ? `${action.label}: прибытия по GPS нет` : action.label}>
      <Icon className={classNames('h-4 w-4', busy && 'animate-spin')} aria-hidden="true" /><span>{record && (action.type === 'MARK_LOADED' || action.type === 'MARK_UNLOADED') ? `Записать ${action.label}` : action.label}</span>
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
    <li className="map-legend-break"><span className="map-legend-source map-legend-source-live" aria-hidden="true" />свежий Webfleet</li>
    <li><span className="map-legend-source map-legend-source-stale" aria-hidden="true" />устарел</li>
    <li><span className="map-legend-source map-legend-source-calculated" aria-hidden="true" />расчёт</li>
  </ul>
}

/** The selected truck at the bottom of the map: status, tour, Termin against ETA, distance, driver hours. */
function VehiclePanel({ row, position, drawerOpen, onToggleDrawer, collapsed, onToggleCollapsed, onOpen, onRouteOptions, optionsBusy, onFocusStop, action, actionPopover, jam }: {
  row: DashboardVehicle; position?: CurrentPosition | null; drawerOpen: boolean; onToggleDrawer: () => void; onOpen: () => void
  collapsed: boolean; onToggleCollapsed: () => void
  onRouteOptions: () => void; optionsBusy: boolean; onFocusStop: (stop: Stop) => void
  action: ReactNode; actionPopover: ReactNode; jam: string | null
}) {
  const progress = useMemo(() => routeProgress(row.tour?.stops, row, position), [row, position])
  const status = vehicleStatus(row)
  const source = positionSource(row)
  const termin = terminOf(row.tour)
  const terminStop = termin ? progress.stops.find(({ stop }) => !stop.completedAt)?.stop ?? null : null
  const margin = terminMargin(row)
  const speed = status.tone !== 'stop' && liveSpeed(row) !== null ? ` · ${liveSpeed(row)} км/ч` : ''
  const remaining = etaPlanLine(row)
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

  const plate = row.telemetry?.objectNo ?? row.vehicle.licensePlate
  const arrived = status.tone === 'stop'
  const big = cardClock(row, status.tone, status.tone === 'stop' && row.dwellMinutes ? Math.round(row.dwellMinutes) : null)
  const bigTime = big?.value ?? '–'
  const here = row.telemetry?.source === 'WEBFLEET' && row.telemetry.address ? row.telemetry.address : vehiclePlace(row)
  // A course only while the truck moves: standing, the last heading says nothing.
  const course = typeof row.telemetry?.courseDeg === 'number' && speed && (liveSpeed(row) ?? 0) >= 5 ? courseWord(row.telemetry.courseDeg) : null
  const motion = [speed ? speed.replace(/^ · /, '') : null, course ? `курс на ${course}` : null].filter(Boolean).join(' · ')
  const stops = row.tour?.stops ?? []
  const firstOpen = stops.findIndex((stop) => !stop.completedAt)
  // The last stop done, then the ones ahead: as the design shows the tour, four lines at most.
  const shownFrom = Math.max(0, (firstOpen < 0 ? stops.length : firstOpen) - 1)
  const shown = stops.slice(shownFrom, shownFrom + 4)
  const cargo = stops.filter((stop) => stop.type === 'LOAD').reduce((sum, stop) => sum + (stop.loadingMeters ?? 0), 0)
  const notice = noticeLine(row)
  const rebuilt = row.lastOperation?.type === 'ROUTE_REBUILT_AUTO' ? formatTime(row.lastOperation.createdAt) : null
  const meters = driverMeters(driver, row.clockSummary)
  const etaMinutes = row.eta ? Math.max(0, Math.round((new Date(row.eta).getTime() - Date.now()) / 60_000)) : null
  const enough = meters?.todayMinutes !== undefined && meters.todayMinutes !== null && etaMinutes !== null && nextStop ? meters.todayMinutes >= etaMinutes : null
  const hasHours = Boolean(meters?.rows.length || hours)
  // Whose hours the ETA was planned on; «без тахографа» already says that the driver's hours are not known.
  const basis = row.eta && row.etaPlan ? (row.etaPlan.hours === 'TACHOGRAPH' ? 'по тахографу' : 'без тахографа') : null
  const hoursBrief = hoursBriefOf(meters, enough, nextStop ? shortAddress(nextStop) : null, basis === 'без тахографа')
  const openStops = stops.filter((stop) => !stop.completedAt)
  // «Опоздание 11 мин» in one pill: the word and the minutes are not said twice.
  const lateBy = status.label === 'Опоздание' && margin !== null && margin < 0 && !arrived ? formatDurationMinutes(-margin) : null
  // Where the position comes from, then where the ETA comes from when that is not the same thing, then whose hours.
  const etaFrom = !row.eta ? null : row.etaSource === 'GPS' ? (source.kind === 'live' ? null : 'ETA от GPS') : source.kind === 'calculated' ? null : 'ETA по расчёту'
  const sourceText = [source.kind === 'calculated' ? 'Расчётная позиция' : source.long, etaFrom, basis].filter(Boolean).join(' · ')
  const sourceTitle = `Позиция: ${source.long}${row.eta ? ` · ETA: ${remaining.source}` : ''}`
  return <section className={classNames('vehicle-panel', drawerOpen && 'vehicle-panel-open')} aria-label={`LKW ${row.vehicle.vehicleNumber}`}>
    {handle}
    <div id="vehicle-panel-body">
    {drawerOpen ? <RouteStopsTrack row={row} position={position} onFocusStop={onFocusStop} /> : null}
    <div className={classNames('vehicle-panel-bar', !hasHours && 'vehicle-panel-bar-nohours')}>
      <div className="vehicle-panel-id">
        <span className="vehicle-panel-kicker"><strong>LKW {row.vehicle.vehicleNumber}</strong>{plate && plate !== row.vehicle.vehicleNumber ? ` · ${plate}` : ''}</span>
        <span className="vehicle-panel-time" aria-label={big ? `${big.label} ${bigTime}` : 'ETA нет'}>{big && big.label !== 'ETA' ? <small>{big.label}</small> : null}{bigTime}</span>
        <span className="vehicle-panel-chips">
          <span className={`status-pill status-pill-${status.tone}`}><span className={`status-dot status-dot-${status.tone}`} aria-hidden="true" />{lateBy ? `Опоздание ${lateBy}` : status.label}</span>
          {margin !== null && !arrived && !lateBy ? <span className={classNames('vehicle-row-chip', margin < 0 ? 'vehicle-row-chip-late' : 'vehicle-row-chip-ok')}>{margin < 0 ? `опоздание ${formatDurationMinutes(-margin)}` : `запас ${formatDurationMinutes(margin)}`}</span> : null}
          {termin ? <span className="vehicle-row-termin" title={terminStop ? shortAddress(terminStop) : undefined}>{terminToday(row) ? termin.label.replace(/^Termin \d{2}\.\d{2} /, 'Termin ') : termin.label}</span>
            : terminNeeded(row) ? <span className="termin-needed">Termin нужен</span> : <span className="vehicle-panel-muted">Termin нет</span>}
        </span>
      </div>
      <div className="vehicle-panel-position">
        <span className="vehicle-panel-head">
          <span className="vehicle-panel-label">Позиция</span>
          {row.etaSource === 'GPS' ? <button type="button" className="vehicle-panel-link" onClick={onRouteOptions} disabled={optionsBusy} title="Три маршрута от GPS-позиции до точки"><GitFork className="h-3.5 w-3.5" aria-hidden="true" />Варианты</button> : null}
        </span>
        <span className="vehicle-panel-route" title={here || undefined}>{here || '–'}</span>
        {motion ? <span className="vehicle-panel-line">{motion}</span> : null}
        {notStarted(row) ? null : <span className="vehicle-panel-line vehicle-panel-left">Осталось {typeof row.remainingKm === 'number' ? `≈ ${Math.round(row.remainingKm)} км` : '–'}{remaining.text ? ` · ${remaining.text}` : ''}</span>}
        {jam ? <span className="vehicle-panel-jam">{jam}</span> : null}
        {activityNote(row) ? <span className={classNames('rest-at-stop', !row.restAtStop && 'rest-at-stop-pause')}>{activityNote(row)}</span> : null}
        <span className={`vehicle-panel-source vehicle-panel-source-${source.kind}`} title={sourceTitle}>{sourceText}</span>
        {/* Where the driver hours have no column of their own (a laptop, or no data), they are one line here. */}
        {hoursBrief ? <span className={classNames('vehicle-panel-hours-brief', hoursBrief.warn && 'vehicle-panel-hours-warn')} title={hoursBrief.title}>{hoursBrief.text}</span> : null}
      </div>
      <div className="vehicle-panel-next">
        <button type="button" className="vehicle-panel-stage route-stops-drawer-trigger" onClick={onToggleDrawer} aria-expanded={drawerOpen} title={drawerOpen ? 'Скрыть точки маршрута' : 'Все точки маршрута'}>
          <span className="sr-only">Точки маршрута · {progress.stops.length}. {progress.stops.length ? `${progress.summary}. ` : ''}</span>
          <span className={classNames('route-stage-summary', `route-stage-summary-${progress.stage.toLowerCase()}`)}>{row.tour ? `Тур ${row.tour.orderNumber}` : 'Нет активного маршрута'}{row.customer ? ` · ${row.customer.name}` : ''}</span>
          {progress.stops.length ? <ChevronDown className={classNames('h-3.5 w-3.5 vehicle-panel-stage-chevron', drawerOpen && 'rotate-180')} aria-hidden="true" /> : null}
          {bar}
        </button>
        <span className="sr-only">Следующая точка: {nextText}.</span>
        {shown.length ? <ol className="vehicle-panel-stops" aria-label="Точки тура">
          {shown.map((stop) => {
            const done = Boolean(stop.completedAt)
            const termin = done ? null : stopTerminLabel(stop, stops, true) ?? (stop.plannedAt ? `план ${formatTime(stop.plannedAt)}` : null)
            const eta = done ? null : stopEta(stop, stops, new Date(), true)
            // In a narrow column a stop takes two lines: then only the stop ahead and the one after it are shown.
            const far = !done && openStops.indexOf(stop) >= 2
            return <li key={stop.id} className={classNames(done && 'vehicle-panel-stop-done', far && 'vehicle-panel-stop-far', stop.id === nextStop?.id && 'vehicle-panel-stop-next')}>
              <span className={`vehicle-panel-stop-dot vehicle-panel-stop-${done ? 'finished' : stop.type === 'LOAD' ? 'load' : 'unload'}`} aria-hidden="true" />
              <b>{stop.type === 'LOAD' ? 'BELADEN' : 'ENTLADEN'}</b><span className="vehicle-panel-stop-name" title={shortAddress(stop)}>{shortAddress(stop)}</span>
              <span className="vehicle-panel-stop-times">
                {done ? <time>{formatTime(stop.completedAt!)}</time> : null}
                {termin ? <span className={stop.plannedAt && !stopTerminLabel(stop, stops) ? undefined : 'vehicle-panel-stop-termin'}>{termin}</span> : null}
                {eta ? <span className={classNames('vehicle-panel-stop-eta', eta.late && 'timing-late')} title={eta.title}>{eta.text}</span> : null}
              </span>
            </li>
          })}
        </ol> : <span className="vehicle-panel-route"><MapPin className="h-4 w-4" aria-hidden="true" />{nextText}</span>}
        {cargo || zuladungState(row.tour) === 'OPEN' || stops.length > 2 ? <span className="vehicle-panel-foot">
          <span className="vehicle-panel-line">
            {cargo ? `Груз: ${cargo.toLocaleString('de-DE')} LDM` : null}
            {zuladungState(row.tour) === 'OPEN' ? <span className="vehicle-panel-zuladung" title="По Auftrag перед выгрузкой возможна Zuladung, место неизвестно">{cargo ? ' · ' : ''}без учёта Zuladung</span> : null}
          </span>
          {stops.length > 2 ? <button type="button" className="vehicle-panel-link" onClick={onToggleDrawer} aria-expanded={drawerOpen}>Все точки · {stops.length}</button> : null}
        </span> : null}
        {rebuilt || notice ? <span className="vehicle-panel-meta">
          {rebuilt ? <span>Маршрут перестроен сам в {rebuilt}</span> : null}
          {notice ? <span className="customer-notice-line">{notice}</span> : null}
        </span> : null}
      </div>
      {hasHours ? <div className={classNames('vehicle-panel-hours', hours?.stale && 'vehicle-panel-hours-stale')} aria-label="Часы водителя" role="group">
        <span className="vehicle-panel-label">Часы водителя{meters?.tachograph ? ' · тахограф' : ''}</span>
        {meters?.rows.length ? meters.rows.map((item) => <span key={item.label} className={classNames('vehicle-panel-meter', item.warn && 'vehicle-panel-hours-warn')}>
          <span>{item.label}</span><strong>{item.value}</strong>
          {item.share !== null ? <i aria-hidden="true"><b style={{ width: `${Math.round(Math.min(1, Math.max(0, item.share)) * 100)}%` }} /></i> : null}
        </span>) : hours ? hours.parts.map((part) => <span key={part.label} className={classNames('vehicle-panel-meter', part.warn && 'vehicle-panel-hours-warn')}><span>{part.label}</span><strong>{part.value}</strong></span>) : null}
        {enough !== null && nextStop ? <span className={enough ? 'vehicle-panel-enough' : 'vehicle-panel-hours-warn'}>{enough ? `Хватает до ${shortAddress(nextStop)}` : `Не хватает до ${shortAddress(nextStop)}: нужен отдых`}</span> : null}
        {hours ? <span className="vehicle-panel-hours-source">{hours.source}{hours.stale ? ' · устарели' : ''}</span> : null}
      </div> : null}
      <div className="vehicle-panel-actions">
        {action}
        {noticeDue(row) ? <CustomerNoticeButton row={row} /> : null}
        <button type="button" className="secondary-button" onClick={onOpen}>Открыть панель<ChevronUp className="h-4 w-4" aria-hidden="true" /></button>
      </div>
    </div>
    {actionPopover ? <div className="vehicle-panel-popover">{actionPopover}</div> : null}
    </div>
  </section>
}

/** The driver's day as the design shows it: three meters with the time left, from the tachograph or the OPS clock. */
function driverMeters(times: DrivingTimes | null | undefined, clock: DashboardVehicle['clockSummary'] | undefined, now = Date.now()) {
  const rows: Array<{ label: string; value: string; share: number | null; warn?: boolean }> = []
  if (times?.referenceTime) {
    const breakIn = times.nextBreakAt ? Math.max(0, Math.round((new Date(times.nextBreakAt).getTime() - now) / 60_000)) : null
    if (breakIn !== null) rows.push({ label: 'До паузы', value: formatClock(breakIn), share: breakIn / 270, warn: breakIn <= 15 })
    const today = times.remainDrivingTodayMs !== null ? Math.max(0, Math.floor(times.remainDrivingTodayMs / 60_000)) : null
    if (today !== null) rows.push({ label: 'Сегодня осталось', value: formatClock(today), share: today / Math.max(1, (times.maxDrivingTodayMs ?? 9 * 3600_000) / 60_000), warn: today <= 30 })
    if (times.maxDrivingWeekMs && times.remainDrivingWeekMs !== null) {
      const max = Math.round(times.maxDrivingWeekMs / 60_000), driven = Math.max(0, max - Math.round(times.remainDrivingWeekMs / 60_000))
      rows.push({ label: 'Неделя', value: `${formatClock(driven)} из ${Math.round(max / 60)}`, share: driven / max })
    }
    if (rows.length) return { rows, tachograph: true, todayMinutes: today }
  }
  if (clock) {
    if (typeof clock.breakInMinutes === 'number') rows.push({ label: 'До паузы', value: formatClock(clock.breakInMinutes), share: clock.breakInMinutes / 270, warn: clock.breakInMinutes <= 15 })
    if (typeof clock.remainingDrivingMinutes === 'number') rows.push({ label: 'Сегодня осталось', value: formatClock(clock.remainingDrivingMinutes), share: clock.remainingDrivingMinutes / 540 })
    if (typeof clock.remainingDutyMinutes === 'number') rows.push({ label: 'До конца смены', value: formatClock(clock.remainingDutyMinutes), share: null })
    if (rows.length) return { rows, tachograph: false, todayMinutes: clock.remainingDrivingMinutes ?? null }
  }
  return null
}

/** The driver's hours in one line, for the panel without room for their column: «До паузы 0:45 · сегодня осталось 1:37». */
function hoursBriefOf(meters: ReturnType<typeof driverMeters>, enough: boolean | null, place: string | null, said: boolean): { text: string; title: string; warn: boolean } | null {
  if (!meters?.rows.length) return said ? null : { text: 'Часы водителя: нет данных', title: 'Тахограф Webfleet не прислал часы, расчёта OPS тоже нет', warn: false }
  const all = meters.rows.map((item) => `${item.label} ${item.value}`)
  const verdict = enough === false && place ? `не хватает до ${place}` : null
  const source = meters.tachograph ? 'по тахографу Webfleet' : 'расчёт OPS, предварительно'
  return {
    text: [verdict, ...all.slice(0, 2)].filter(Boolean).join(' · ').replace('Сегодня осталось', 'сегодня осталось'),
    title: `Часы водителя, ${source}: ${all.join(' · ')}`,
    warn: enough === false || meters.rows.slice(0, 2).some((item) => item.warn)
  }
}

/** «пробка: +25 мин» from the open jam notice of the truck, as the position column of the design shows it. */
function jamOf(items: AlertNotification[], vehicleId: string): string | null {
  const jam = items.find((item) => item.vehicleId === vehicleId && item.type === 'TRAFFIC_DELAY' && !item.resolved)
  if (!jam) return null
  let seconds: number | null = null
  try { const payload = JSON.parse(jam.payloadJson ?? '{}') as { delaySeconds?: unknown }; seconds = typeof payload.delaySeconds === 'number' ? payload.delaySeconds : null } catch { /* the message still says it */ }
  const minutes = seconds !== null ? Math.round(seconds / 60) : Number(/(\d+)\s*мин/.exec(jam.message)?.[1] ?? NaN)
  return Number.isFinite(minutes) && minutes > 0 ? `пробка: +${formatDurationMinutes(minutes)}` : 'пробка на маршруте'
}

/** What the map label says next to the number: the time against the Termin, then the speed and the way left. */
function mapLabel(row: DashboardVehicle): { headline: string | null; detail: string | null } {
  const status = vehicleStatus(row)
  const source = positionSource(row)
  if (status.tone === 'stop') {
    const dwell = row.dwellMinutes ? Math.round(row.dwellMinutes) : null
    return { headline: dwell ? `на точке ${formatDurationMinutes(dwell)}` : 'на точке', detail: [row.currentStop ? shortAddress(row.currentStop) : null, source.kind === 'stale' ? source.long : null].filter(Boolean).join(' · ') || null }
  }
  if (!row.eta) return { headline: null, detail: source.kind === 'stale' ? source.long : null }
  const margin = terminMargin(row)
  const headline = `${formatTime(row.eta)}${margin !== null ? margin < 0 ? ` · опоздание ${formatDurationMinutes(-margin)}` : ` · запас ${formatDurationMinutes(margin)}` : ''}`
  const speed = liveSpeed(row) !== null ? `${liveSpeed(row)} км/ч` : null
  const way = typeof row.remainingKm === 'number' ? `до ${shortAddress(row.to)} ${Math.round(row.remainingKm)} км` : null
  return { headline, detail: source.kind === 'stale' ? source.long : [speed, way].filter(Boolean).join(' · ') || null }
}

const COURSES = ['север', 'северо-восток', 'восток', 'юго-восток', 'юг', 'юго-запад', 'запад', 'северо-запад']
function courseWord(degrees: number) { return COURSES[Math.round((((degrees % 360) + 360) % 360) / 45) % 8] }

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
        <StopCard stop={stop} stops={row.tour?.stops ?? []} current={index === progress.currentIndex} onFocus={() => onFocusStop(stop)} />
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
  if (state === 'HEADING') return stage === 'ARRIVING' ? 'Прибывает · ждём GPS' : stage === 'WAITING' ? 'Первая точка' : manuallyStopped(row) ? 'Остановлена на пути сюда' : `Едем сюда · ETA ${etaText(row.eta ?? stop.predictedEta)}`
  return state === 'NEXT' ? 'Следующая' : 'Впереди'
}

function StopCard({ stop, stops, current = false, onFocus }: { stop: Stop; stops: Stop[]; current?: boolean; onFocus?: () => void }) {
  const references = stop.referenceNumbers ?? parseStopReferences(stop.referenceNumbersJson)
  const eta = stop.completedAt ? null : stopEta(stop, stops)
  // The whole card shows the stop on the map.
  return <article className={classNames('route-stop-card', current && 'route-stop-card-current', onFocus && 'route-stop-card-clickable')} onClick={onFocus}
    role={onFocus ? 'button' : undefined} tabIndex={onFocus ? 0 : undefined} aria-label={onFocus ? `Показать на карте: ${stop.sequence} · ${stopTypeLabel(stop.type)}, ${shortAddress(stop)}` : undefined}
    onKeyDown={onFocus ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onFocus() } } : undefined}><div className="flex items-center justify-between gap-2"><span className="badge border-slate-200 bg-slate-50 text-slate-700">{stop.sequence} · {stopTypeLabel(stop.type)}</span><span className="text-xs font-medium text-slate-500">{stop.status ? statusLabel(stop.status) : ''}</span></div><p className="mt-2 truncate font-semibold" title={stop.city || stop.address}>{shortAddress(stop)}</p><p className="mt-1 line-clamp-2 text-xs text-slate-500" title={stop.address}>{stop.address}</p><div className="mt-3 grid gap-1 text-xs text-slate-600"><span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> {stopTerminLabel(stop, stops) ?? 'Termin нет'}</span>{eta ? <span className={classNames('inline-flex items-center gap-1', eta.late && 'timing-late')} title={eta.title}><MapPin className="h-3.5 w-3.5" /> {eta.text}</span> : null}{stop.loadingMeters ? <span>{stop.loadingMeters} LDM</span> : null}{references.length ? <span>Ref: {references.join(', ')}</span> : null}{stop.instructions ? <span className="line-clamp-2">{stop.instructions}</span> : null}</div></article>
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

/** URL state of the Disposition with the phone tab kept. */
function withView(params: Record<string, string>, view: 'list' | 'map'): Record<string, string> {
  return view === 'map' ? { ...params, view: 'map' } : params
}
