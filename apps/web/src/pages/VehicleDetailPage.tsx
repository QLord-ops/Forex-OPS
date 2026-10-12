import { Check, PackageCheck, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'

import { MapPanel } from '../components/MapPanel'
import { AppointmentPlanner } from '../components/AppointmentPlanner'
import { VehicleOperationsPanel } from '../components/VehicleOperationsPanel'
import { RouteEditor } from '../components/RouteEditor'
import { ErrorState, LoadingState } from '../components/States'
import { TourStatusBadge } from '../components/StatusBadge'
import { TourTimeline } from '../components/Timeline'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import {
  calculatedPositionLabel,
  formatDateTime,
  formatAppointment,
  formatDelay,
  metersToKm,
  routeTitle,
  shortAddress,
  statusLabel
} from '../lib/format'
import type { CurrentPosition, Stop, Tour } from '../types/domain'

export function VehicleDetailPage() {
  const { id = '' } = useParams()
  const [actionError, setActionError] = useState<Error | null>(null)
  const [busyStopId, setBusyStopId] = useState<string | null>(null)
  const vehicle = usePolling(() => api.vehicle(id), 30_000, Boolean(id), id)
  const tours = usePolling(() => api.vehicleTours(id), 30_000, Boolean(id), id)
  const timeline = usePolling(() => api.vehicleTimeline(id), 30_000, Boolean(id), id)
  const position = usePolling(() => api.currentPosition(id), 5_000, Boolean(id), id)
  const refreshOperations = () => Promise.all([tours.refetch(), timeline.refetch(), position.refetch()])

  const activeTour = useMemo(() => {
    const list = tours.data ?? timeline.data?.tours ?? []
    return list.find((tour) => tour.status === 'ACTIVE') ?? list.find((tour) => tour.status === 'QUEUED') ?? list[0]
  }, [timeline.data?.tours, tours.data])

  const currentStop = useMemo(() => findNextActionStop(activeTour), [activeTour])

  async function handleStopAction(stop: Stop) {
    setActionError(null)
    setBusyStopId(stop.id)
    try {
      if (stop.type === 'LOAD') {
        await api.markLoaded(stop.id)
      } else {
        await api.markUnloaded(stop.id)
      }
      await Promise.all([tours.refetch(), timeline.refetch(), position.refetch()])
    } catch (error) {
      setActionError(error as Error)
    } finally {
      setBusyStopId(null)
    }
  }

  if ((vehicle.loading || tours.loading) && (!vehicle.data || !tours.data)) {
    return <LoadingState label="Грузовик загружается" />
  }

  if (vehicle.error && !vehicle.data) return <ErrorState error={vehicle.error} onRetry={vehicle.refetch} />
  if (tours.error && !tours.data) return <ErrorState error={tours.error} onRetry={tours.refetch} />

  return (
    <div className="space-y-5">
      <div className="page-header items-start">
        <div className="min-w-0">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Грузовик</p>
          <h2 className="page-title tabular-nums">Грузовик {vehicle.data?.vehicleNumber}</h2>
          <p className="page-subtitle">
            {vehicle.data?.licensePlate || 'Госномер не указан'} · макс. {vehicle.data?.maxSpeedKmh ?? 85} км/ч
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="secondary-button" onClick={() => void Promise.all([vehicle.refetch(), tours.refetch(), timeline.refetch(), position.refetch()])}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Обновить
          </button>
          {currentStop ? (
            <button
              className="primary-button"
              disabled={busyStopId === currentStop.id || !currentStop.arrivedAt}
              title={!currentStop.arrivedAt ? 'Сначала подтвердите фактическое прибытие' : undefined}
              onClick={() => void handleStopAction(currentStop)}
            >
              {currentStop.type === 'LOAD' ? <PackageCheck className="h-4 w-4" /> : <Check className="h-4 w-4" />}
              {currentStop.type === 'LOAD' ? 'ЗАГРУЖЕНО' : 'ВЫГРУЖЕНО'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,440px)]">
        <div className="min-w-0 space-y-4">
          <MapPanel tour={activeTour} position={position.data} />
          <MetricsPanel tour={activeTour} position={position.data} />
        </div>
        <div className="min-w-0 space-y-4">
          <TourSummary tour={activeTour} />
          {activeTour && ['ACTIVE', 'QUEUED'].includes(activeTour.status) ? <AppointmentPlanner key={`appointment-${activeTour.id}`} tour={activeTour} onChange={refreshOperations} /> : null}
          <VehicleOperationsPanel key={id} vehicleId={id} onChange={refreshOperations} />
          {activeTour && ['ACTIVE', 'QUEUED'].includes(activeTour.status) && <RouteEditor key={activeTour.id} tour={activeTour} onChange={refreshOperations} />}
          {actionError ? <ErrorState error={actionError} /> : null}
          {position.error ? <ErrorState error={position.error} onRetry={position.refetch} /> : null}
          <TourTimeline tours={timeline.data?.tours ?? tours.data ?? []} items={timeline.data?.items} />
        </div>
      </div>
    </div>
  )
}

function MetricsPanel({ tour, position }: { tour?: Tour | null; position?: CurrentPosition | null }) {
  const progress = Math.round(((position?.progress ?? 0) * 100 + Number.EPSILON) * 10) / 10

  return (
    <section className="work-surface grid min-w-0 gap-3 p-4 md:grid-cols-4">
      <Metric label="Статус" value={statusLabel(position?.status)} />
      <Metric label="Начало" value={formatDateTime(position?.startedAt)} />
      <Metric label="ETA" value={formatDateTime(position?.eta ?? tour?.predictedEta)} />
      <Metric label="Опоздание" value={formatDelay(position?.delayMinutes ?? tour?.predictedDelayMinutes)} accent={(position?.delayMinutes ?? 0) > 0} />
      <Metric label="Пройдено" value={metersToKm(position?.distanceTravelledMeters)} />
      <Metric label="Осталось" value={metersToKm(position?.remainingDistanceMeters)} />
      <Metric label="Прогресс" value={`${progress}%`} />
      <Metric label="Примечание" value={calculatedPositionLabel} />
    </section>
  )
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={accent ? 'mt-1 text-lg font-bold text-red-700' : 'mt-1 text-lg font-semibold text-slate-950'}>{value}</div>
    </div>
  )
}

function TourSummary({ tour }: { tour?: Tour | null }) {
  if (!tour) {
    return (
      <section className="work-surface p-4">
        <h3 className="font-semibold">Нет активного маршрута</h3>
        <p className="mt-1 text-sm text-slate-500">У этого грузовика сейчас нет активного или ожидающего маршрута.</p>
      </section>
    )
  }

  const stops = tour.stops?.slice().sort((a, b) => a.sequence - b.sequence) ?? []

  return (
    <section className="work-surface min-w-0 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Текущий маршрут</h3>
          <p className="mt-1 text-sm text-slate-600">{routeTitle(tour)}</p>
        </div>
        <TourStatusBadge status={tour.status} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-slate-500">Заказ</dt>
          <dd className="font-semibold">{tour.orderNumber}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Срок</dt>
          <dd className="font-semibold">{formatAppointment(stops.at(-1)?.appointmentAt)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Откуда</dt>
          <dd className="font-semibold">{shortAddress(stops[0])}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Куда</dt>
          <dd className="font-semibold">{shortAddress(stops.at(-1))}</dd>
        </div>
      </dl>
    </section>
  )
}

function findNextActionStop(tour?: Tour | null) {
  if (!tour || tour.status !== 'ACTIVE') return null
  return tour.stops?.slice().sort((a, b) => a.sequence - b.sequence).find((stop) => !stop.completedAt) ?? null
}
