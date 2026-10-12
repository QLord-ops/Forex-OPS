import {
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clock3,
  MapPin,
  Pin,
  PinOff,
  RefreshCw,
  Search
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { MapPanel } from '../components/MapPanel'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import {
  classNames,
  formatAppointment,
  formatDateTime,
  formatDelay,
  formatKm,
  shortAddress,
  statusLabel,
  stopTypeLabel
} from '../lib/format'
import type { DashboardVehicle } from '../types/domain'

const PIN_STORAGE_KEY = 'ops-dashboard-pinned-vehicles'

type FleetFilter = 'ALL' | 'ATTENTION' | 'MOVING' | 'AT_STOP' | 'IDLE'

const filters: Array<{ value: FleetFilter; label: string }> = [
  { value: 'ALL', label: 'Все' },
  { value: 'ATTENTION', label: 'Контроль' },
  { value: 'MOVING', label: 'В пути' },
  { value: 'AT_STOP', label: 'На точке' },
  { value: 'IDLE', label: 'Без тура' }
]

export function DashboardPage() {
  const { data, error, loading, refetch } = usePolling(api.dashboard, 30_000)
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FleetFilter>('ALL')
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [pinned, setPinned] = useState<string[]>(readPinnedVehicles)

  const vehicles = useMemo(() => data?.vehicles ?? [], [data?.vehicles])
  const orderedVehicles = useMemo(
    () => vehicles.slice().sort((a, b) => compareVehicles(a, b, pinned)),
    [pinned, vehicles]
  )
  const selectedId = searchParams.get('vehicleId') ?? ''
  const selected = vehicles.find((row) => row.vehicle.id === selectedId) ?? orderedVehicles[0] ?? null
  const position = usePolling(
    () => api.currentPosition(selected?.vehicle.id ?? ''),
    5_000,
    Boolean(selected?.vehicle.id),
    selected?.vehicle.id ?? 'none'
  )

  useEffect(() => {
    if (!orderedVehicles.length || vehicles.some((row) => row.vehicle.id === selectedId)) return
    setSearchParams({ vehicleId: orderedVehicles[0].vehicle.id }, { replace: true })
  }, [orderedVehicles, selectedId, setSearchParams, vehicles])

  const visibleVehicles = orderedVehicles.filter((row) => {
    const needle = query.trim().toLocaleLowerCase('ru-RU')
    const matchesQuery = !needle || [
      row.vehicle.vehicleNumber,
      row.vehicle.licensePlate,
      row.tour?.orderNumber,
      shortAddress(row.from),
      shortAddress(row.to)
    ].some((value) => value?.toLocaleLowerCase('ru-RU').includes(needle))
    return matchesQuery && matchesFleetFilter(row, filter)
  })

  function selectVehicle(vehicleId: string) {
    setSearchParams({ vehicleId }, { replace: true })
  }

  function togglePin(vehicleId: string) {
    setPinned((current) => {
      const next = current.includes(vehicleId)
        ? current.filter((id) => id !== vehicleId)
        : [...current, vehicleId]
      window.localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  if (loading && !data) return <LoadingState />
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="page-title">Контроль автопарка</h2>
            <span className="badge border-slate-200 bg-white text-slate-700">{vehicles.length} LKW</span>
          </div>
          <p className="page-subtitle">Обновлено {formatDateTime(data?.generatedAt)} · расчёт каждые 30 секунд</p>
        </div>
        <button className="secondary-button" onClick={() => void Promise.all([refetch(), position.refetch()])}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Обновить данные
        </button>
      </div>

      <div className="dashboard-workspace">
        <aside className="fleet-rail work-surface" aria-label="Список грузовиков">
          <div className="border-b border-slate-200 p-3">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <span className="sr-only">Найти грузовик</span>
              <input className="field-input pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="LKW, Auftrag или город" />
            </label>
            <div className="mt-3 flex gap-1 overflow-x-auto pb-1" aria-label="Фильтр автопарка">
              {filters.map((item) => (
                <button key={item.value} type="button" className={classNames('filter-chip', filter === item.value && 'filter-chip-active')} onClick={() => setFilter(item.value)}>
                  {item.label}
                </button>
              ))}
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
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="text-xl font-black tabular-nums">LKW {row.vehicle.vehicleNumber}</span>
                          {row.vehicle.licensePlate ? <span className="truncate text-xs font-semibold text-slate-500">{row.vehicle.licensePlate}</span> : null}
                        </div>
                        <p className="mt-0.5 truncate text-sm font-semibold text-slate-800">
                          {shortAddress(row.to)}{row.to ? ` · ${stopTypeLabel(row.to.type)}` : ''}
                        </p>
                      </div>
                      <span className={classNames('attention-pill', `attention-pill-${attention.tone}`)}>{attention.label}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      <RailMetric label="Статус" value={statusLabel(row.statusText)} />
                      <RailMetric label="ETA" value={formatDateTime(row.eta)} />
                      <RailMetric label="Срок" value={formatAppointment(row.appointmentAt)} />
                      <RailMetric label="Отклонение" value={formatDelay(row.delayMinutes)} accent={(row.delayMinutes ?? 0) > 0} />
                    </div>
                    <p className="mt-3 flex items-start gap-1.5 text-xs font-medium text-slate-600">
                      <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="text-balance-safe">{attention.reason}</span>
                    </p>
                  </button>
                  <button type="button" className="icon-button ml-2 self-start" onClick={() => togglePin(row.vehicle.id)} aria-label={isPinned ? `Открепить LKW ${row.vehicle.vehicleNumber}` : `Закрепить LKW ${row.vehicle.vehicleNumber}`} title={isPinned ? 'Открепить' : 'Закрепить'}>
                    {isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                  </button>
                </article>
              )
            }) : <EmptyState label="По выбранному фильтру машины не найдены." />}
          </div>
        </aside>

        <div className="min-w-0 space-y-3">
          {selected ? (
            <>
              <section className="map-toolbar work-surface">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-lg font-black tabular-nums">LKW {selected.vehicle.vehicleNumber}</h3>
                    <span className={classNames('attention-pill', `attention-pill-${getAttention(selected).tone}`)}>{getAttention(selected).label}</span>
                  </div>
                  <p className="mt-1 truncate text-sm font-semibold text-slate-600">
                    {selected.tour?.orderNumber ?? 'Нет активного Auftrag'} · {shortAddress(selected.from)} → {shortAddress(selected.to)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <ToolbarMetric label="ETA" value={formatDateTime(selected.eta)} />
                  <ToolbarMetric label="Осталось" value={formatKm(selected.remainingKm)} />
                  <ToolbarMetric label="Опоздание" value={formatDelay(selected.delayMinutes)} accent={(selected.delayMinutes ?? 0) > 0} />
                  <Link className="primary-button" to={`/vehicles/${selected.vehicle.id}`}>Открыть LKW <ArrowUpRight className="h-4 w-4" aria-hidden="true" /></Link>
                </div>
              </section>

              <div className="dashboard-map min-w-0"><MapPanel tour={selected.tour} position={position.data} height={480} /></div>

              <section className="work-surface overflow-hidden">
                <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" onClick={() => setDetailsOpen((value) => !value)} aria-expanded={detailsOpen}>
                  <span><span className="block font-bold">Текущий тур и следующие точки</span><span className="block text-sm text-slate-500">Маршрут, сроки и быстрый переход к управлению</span></span>
                  {detailsOpen ? <ChevronUp className="h-5 w-5 shrink-0" /> : <ChevronDown className="h-5 w-5 shrink-0" />}
                </button>
                {detailsOpen ? <TourStrip row={selected} /> : null}
              </section>
            </>
          ) : <EmptyState label="Добавьте грузовик и Auftrag, чтобы увидеть рабочую карту." />}
          {position.error ? <ErrorState error={position.error} onRetry={position.refetch} /> : null}
        </div>
      </div>
      {error ? <ErrorState error={error} onRetry={refetch} /> : null}
    </div>
  )
}

function TourStrip({ row }: { row: DashboardVehicle }) {
  const stops = row.tour?.stops?.slice().sort((a, b) => a.sequence - b.sequence) ?? []
  if (!stops.length) return <div className="border-t border-slate-200 p-4"><EmptyState label="У машины нет активного маршрута." /></div>
  return (
    <div className="border-t border-slate-200 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {stops.map((stop) => (
          <div key={stop.id} className="route-stop-card">
            <div className="flex items-center justify-between gap-2">
              <span className="badge border-slate-200 bg-slate-50 text-slate-700">{stop.sequence} · {stopTypeLabel(stop.type)}</span>
              <span className="text-xs font-semibold text-slate-500">{stop.status ? statusLabel(stop.status) : ''}</span>
            </div>
            <p className="mt-2 truncate font-bold" title={stop.city || stop.address}>{shortAddress(stop)}</p>
            <p className="mt-1 line-clamp-2 text-xs text-slate-500" title={stop.address}>{stop.address}</p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> {formatAppointment(stop.appointmentAt)}</span>
              <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> ETA {formatDateTime(stop.predictedEta)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function RailMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="min-w-0"><span className="metric-label">{label}</span><span className={classNames('block truncate font-bold', accent ? 'text-red-700' : 'text-slate-800')}>{value}</span></div>
}

function ToolbarMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="min-w-[84px] rounded-md bg-slate-50 px-3 py-2"><span className="metric-label">{label}</span><span className={classNames('block whitespace-nowrap text-sm font-black tabular-nums', accent ? 'text-red-700' : 'text-slate-900')}>{value}</span></div>
}

function compareVehicles(a: DashboardVehicle, b: DashboardVehicle, pinned: string[]) {
  const rankDifference = getAttention(a).rank - getAttention(b).rank
  if (rankDifference) return rankDifference
  const pinDifference = Number(pinned.includes(b.vehicle.id)) - Number(pinned.includes(a.vehicle.id))
  if (pinDifference) return pinDifference
  const delayDifference = (b.delayMinutes ?? 0) - (a.delayMinutes ?? 0)
  if (delayDifference) return delayDifference
  return a.vehicle.vehicleNumber.localeCompare(b.vehicle.vehicleNumber, 'ru', { numeric: true })
}

function getAttention(row: DashboardVehicle): { rank: number; tone: 'critical' | 'action' | 'watch' | 'moving' | 'ok' | 'idle'; label: string; reason: string } {
  if (row.risk === 'RED' || (row.delayMinutes ?? 0) > 0) return { rank: 0, tone: 'critical', label: 'Критично', reason: `Опоздание ${formatDelay(row.delayMinutes)}` }
  if (row.risk === 'ORANGE' || row.statusText === 'ARRIVED') return { rank: 1, tone: 'action', label: 'Нужно действие', reason: row.statusText === 'ARRIVED' ? 'Ожидается подтверждение операции на точке' : 'Высокий риск нарушения срока' }
  if (row.risk === 'YELLOW') return { rank: 2, tone: 'watch', label: 'Контроль', reason: 'Небольшой запас до термина' }
  if (row.statusText === 'MOVING') return { rank: 3, tone: 'moving', label: 'В пути', reason: 'Движется по расчётному маршруту' }
  if (row.risk === 'GREEN') return { rank: 4, tone: 'ok', label: 'По плану', reason: 'Отклонений по текущему расчёту нет' }
  return { rank: 5, tone: 'idle', label: 'Без контроля', reason: row.tour ? statusLabel(row.statusText) : 'Нет активного тура' }
}

function matchesFleetFilter(row: DashboardVehicle, filter: FleetFilter) {
  const attention = getAttention(row)
  if (filter === 'ALL') return true
  if (filter === 'ATTENTION') return attention.rank <= 2
  if (filter === 'MOVING') return row.statusText === 'MOVING'
  if (filter === 'AT_STOP') return ['ARRIVED', 'WAITING', 'MANUAL_STOP'].includes(row.statusText)
  return !row.tour || ['IDLE', 'NO_ACTIVE_ROUTE'].includes(row.statusText)
}

function readPinnedVehicles(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PIN_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}
