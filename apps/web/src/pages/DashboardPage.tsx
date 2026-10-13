import { ArrowUpRight, ChevronDown, CircleDot, Clock3, MapPin, Pin, PinOff, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { MapPanel } from '../components/MapPanel'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import { classNames, formatAppointment, formatDateTime, formatDelay, formatDurationMinutes, formatKm, shortAddress, statusLabel, stopTypeLabel } from '../lib/format'
import type { DashboardVehicle, Stop } from '../types/domain'

const PIN_STORAGE_KEY = 'ops-dashboard-pinned-vehicles'
type FleetFilter = 'ALL' | 'ATTENTION' | 'MOVING' | 'AT_STOP' | 'IDLE'
type AttentionTone = 'dwell' | 'critical' | 'action' | 'watch' | 'moving' | 'ok' | 'idle'
const filters: Array<{ value: FleetFilter; label: string }> = [
  { value: 'ALL', label: 'Все' }, { value: 'ATTENTION', label: 'Контроль' },
  { value: 'MOVING', label: 'В пути' }, { value: 'AT_STOP', label: 'На точке' },
  { value: 'IDLE', label: 'Без тура' }
]

export function DashboardPage() {
  const { data, error, loading, refetch } = usePolling(api.dashboard, 10_000)
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FleetFilter>('ALL')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [hudOpen, setHudOpen] = useState(false)
  const [pinned, setPinned] = useState<string[]>(readPinnedVehicles)
  const vehicles = useMemo(() => data?.vehicles ?? [], [data?.vehicles])
  const orderedVehicles = useMemo(() => vehicles.slice().sort((a, b) => compareVehicles(a, b, pinned)), [pinned, vehicles])
  const selectedId = searchParams.get('vehicleId') ?? ''
  const selected = vehicles.find((row) => row.vehicle.id === selectedId) ?? orderedVehicles[0] ?? null
  const position = usePolling(() => api.currentPosition(selected?.vehicle.id ?? ''), 5_000, Boolean(selected?.vehicle.id), selected?.vehicle.id ?? 'none')

  useEffect(() => {
    if (!orderedVehicles.length || vehicles.some((row) => row.vehicle.id === selectedId)) return
    setSearchParams({ vehicleId: orderedVehicles[0].vehicle.id }, { replace: true })
  }, [orderedVehicles, selectedId, setSearchParams, vehicles])
  useEffect(() => { setDrawerOpen(false); setHudOpen(false) }, [selected?.vehicle.id])

  const visibleVehicles = orderedVehicles.filter((row) => {
    const needle = query.trim().toLocaleLowerCase('ru-RU')
    const matchesQuery = !needle || [row.vehicle.vehicleNumber, row.vehicle.licensePlate, row.tour?.orderNumber, shortAddress(row.from), shortAddress(row.to)]
      .some((value) => value?.toLocaleLowerCase('ru-RU').includes(needle))
    return matchesQuery && matchesFleetFilter(row, filter)
  })

  function selectVehicle(vehicleId: string) { setSearchParams({ vehicleId }, { replace: true }) }
  function togglePin(vehicleId: string) {
    setPinned((current) => {
      const next = current.includes(vehicleId) ? current.filter((id) => id !== vehicleId) : [...current, vehicleId]
      window.localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(next))
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
          <div className="mt-2 flex gap-1 overflow-x-auto pb-1" aria-label="Фильтр автопарка">
            {filters.map((item) => <button key={item.value} type="button" className={classNames('filter-chip', filter === item.value && 'filter-chip-active')} onClick={() => setFilter(item.value)}>{item.label}</button>)}
          </div>
        </div>
        <div className="fleet-list">
          {visibleVehicles.length ? visibleVehicles.map((row) => {
            const attention = getAttention(row)
            const isSelected = selected?.vehicle.id === row.vehicle.id
            const isPinned = pinned.includes(row.vehicle.id)
            return (
              <article key={row.vehicle.id} className={classNames('vehicle-card', `vehicle-card-${attention.tone}`, isSelected && 'vehicle-card-selected')}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => selectVehicle(row.vehicle.id)}>
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2"><span className="text-lg font-black tabular-nums">LKW {row.vehicle.vehicleNumber}</span>{row.vehicle.licensePlate ? <span className="truncate text-xs font-semibold text-slate-500">{row.vehicle.licensePlate}</span> : null}</div>
                      <p className="mt-0.5 truncate text-sm font-semibold text-slate-800">{shortAddress(row.to)}{row.to ? ` · ${stopTypeLabel(row.to.type)}` : ''}</p>
                    </div>
                    <span className={classNames('attention-pill', `attention-pill-${attention.tone}`)}>{attention.label}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                    <RailMetric label="Статус" value={statusLabel(row.statusText)} /><RailMetric label="ETA" value={formatDateTime(row.eta)} />
                    <RailMetric label="Срок" value={formatAppointment(row.appointmentAt)} /><RailMetric label="Отклонение" value={formatDelay(row.delayMinutes)} accent={(row.delayMinutes ?? 0) > 0} />
                  </div>
                  <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-slate-600"><CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span className="text-balance-safe">{attention.reason}</span></p>
                </button>
                <button type="button" className="icon-button ml-1.5 self-start" onClick={() => togglePin(row.vehicle.id)} aria-label={isPinned ? `Открепить LKW ${row.vehicle.vehicleNumber}` : `Закрепить LKW ${row.vehicle.vehicleNumber}`} title={isPinned ? 'Открепить' : 'Закрепить'}>{isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}</button>
              </article>
            )
          }) : <EmptyState label="По выбранному фильтру машины не найдены." />}
        </div>
      </aside>
      <section className="dashboard-stage" aria-label="Карта выбранного грузовика">
        {selected ? <><MapPanel tour={selected.tour} position={position.data} height="100%" fill /><VehicleMapHud row={selected} open={hudOpen} onToggle={() => setHudOpen((value) => !value)} /><RouteStopsDrawer row={selected} open={drawerOpen} onToggle={() => setDrawerOpen((value) => !value)} /></> : <div className="grid h-full place-items-center bg-slate-100 p-6"><EmptyState label="Добавьте грузовик и Auftrag, чтобы увидеть рабочую карту." /></div>}
        {position.error ? <button type="button" className="map-error" onClick={() => void position.refetch()}>Позиция временно недоступна · повторить</button> : null}
        {error ? <div className="dashboard-sync-warning">Данные автопарка не обновлены. Повторим автоматически.</div> : null}
      </section>
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

function RouteStopsDrawer({ row, open, onToggle }: { row: DashboardVehicle; open: boolean; onToggle: () => void }) {
  const stops = row.tour?.stops?.slice().sort((a, b) => a.sequence - b.sequence) ?? []
  return <div className={classNames('route-stops-drawer', open && 'route-stops-drawer-open')}>
    <button type="button" className="route-stops-drawer-trigger" onClick={onToggle} aria-expanded={open}><span className="drawer-handle" aria-hidden="true" /><span className="min-w-0 text-left"><span className="block text-sm font-black text-slate-950">Точки маршрута · {stops.length}</span><span className="block truncate text-xs font-semibold text-slate-500">{routeSummary(stops)}</span></span><ChevronDown className="drawer-chevron h-5 w-5 shrink-0" aria-hidden="true" /></button>
    <div className="route-stops-drawer-body">{stops.length ? <div className="route-stops-grid">{stops.map((stop) => <StopCard key={stop.id} stop={stop} />)}</div> : <EmptyState label="У машины нет активного маршрута." />}</div>
  </div>
}

function StopCard({ stop }: { stop: Stop }) {
  return <article className={classNames('route-stop-card', stop.status === 'CURRENT' && 'route-stop-card-current')}><div className="flex items-center justify-between gap-2"><span className="badge border-slate-200 bg-slate-50 text-slate-700">{stop.sequence} · {stopTypeLabel(stop.type)}</span><span className="text-xs font-bold text-slate-500">{stop.status ? statusLabel(stop.status) : ''}</span></div><p className="mt-2 truncate font-black" title={stop.city || stop.address}>{shortAddress(stop)}</p><p className="mt-1 line-clamp-2 text-xs text-slate-500" title={stop.address}>{stop.address}</p><div className="mt-3 grid gap-1 text-xs font-semibold text-slate-600"><span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> {formatAppointment(stop.appointmentAt)}</span><span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> ETA {formatDateTime(stop.predictedEta)}</span></div></article>
}

function RailMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) { return <div className="min-w-0"><span className="metric-label">{label}</span><span className={classNames('block truncate font-bold', accent ? 'text-red-700' : 'text-slate-800')}>{value}</span></div> }
function HudMetric({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) { return <span className="hud-metric"><span>{label}</span><strong className={alert ? 'text-rose-300' : ''}>{value}</strong></span> }

function compareVehicles(a: DashboardVehicle, b: DashboardVehicle, pinned: string[]) {
  const rankDifference = getAttention(a).rank - getAttention(b).rank
  if (rankDifference) return rankDifference
  const pinDifference = Number(pinned.includes(b.vehicle.id)) - Number(pinned.includes(a.vehicle.id))
  if (pinDifference) return pinDifference
  const delayDifference = (b.delayMinutes ?? 0) - (a.delayMinutes ?? 0)
  return delayDifference || a.vehicle.vehicleNumber.localeCompare(b.vehicle.vehicleNumber, 'ru', { numeric: true })
}

function getAttention(row: DashboardVehicle): { rank: number; tone: AttentionTone; label: string; reason: string } {
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
  if (typeof row.dwellMinutes === 'number') return row.dwellMinutes
  const stop = row.currentStop ?? row.tour?.stops?.find((item) => item.arrivedAt && !item.completedAt)
  return stop?.arrivedAt ? Math.max(0, Math.floor((Date.now() - new Date(stop.arrivedAt).getTime()) / 60_000)) : 0
}

function matchesFleetFilter(row: DashboardVehicle, filter: FleetFilter) {
  const attention = getAttention(row)
  if (filter === 'ALL') return true
  if (filter === 'ATTENTION') return attention.rank <= 3
  if (filter === 'MOVING') return row.statusText === 'MOVING'
  if (filter === 'AT_STOP') return ['ARRIVED', 'WAITING', 'MANUAL_STOP'].includes(row.statusText) || getDwellMinutes(row) > 0
  return !row.tour || ['IDLE', 'NO_ACTIVE_ROUTE'].includes(row.statusText)
}

function routeSummary(stops: Stop[]) { return stops.length ? stops.map((stop) => shortAddress(stop)).join(' → ') : 'Нет активного маршрута' }
function readPinnedVehicles(): string[] { try { const parsed = JSON.parse(window.localStorage.getItem(PIN_STORAGE_KEY) ?? '[]'); return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [] } catch { return [] } }
