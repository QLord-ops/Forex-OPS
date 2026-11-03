import { Pencil, RefreshCw, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { DataTable } from '../components/DataTable'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { TourStatusBadge } from '../components/StatusBadge'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import { formatDateTime, formatDelay, routeTitle } from '../lib/format'
import { tourCancellable } from '../lib/tours'
import type { Tour } from '../types/domain'

export function ToursPage() {
  const { data, error, loading, refetch } = usePolling(api.tours, 30_000)
  const [actionError, setActionError] = useState<Error | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  if (loading && !data) return <LoadingState />
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />

  const tours = data ?? []

  async function cancelTour({ id, orderNumber, planVersion }: Tour) {
    if (!window.confirm(`Удалить тур ${orderNumber}? Он пропадёт из цепочки, запись останется в журнале.`)) return
    setCancellingId(id)
    setActionError(null)
    try {
      await api.updateTour(id, { status: 'CANCELLED', version: planVersion })
      await refetch()
    } catch (cause) {
      setActionError(cause as Error)
    } finally {
      setCancellingId(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div className="min-w-0">
          <h2 className="page-title">Маршруты</h2>
          <p className="page-subtitle">Активные, ожидающие и завершённые заказы</p>
        </div>
        <button className="secondary-button" onClick={refetch}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Обновить
        </button>
      </div>

      {tours.length ? (
        <DataTable columns={['Заказ', 'Грузовик', 'Статус', 'Маршрут', 'Запланировано', 'ETA', 'Опоздание', 'Действия']}>
          {tours.map((tour) => (
            <tr key={tour.id} className="hover:bg-slate-50">
              <td className="px-3 py-3 font-semibold">{tour.orderNumber}</td>
              <td className="px-3 py-3 text-sm tabular-nums">{tour.vehicle?.vehicleNumber ?? tour.vehicleId}</td>
              <td className="px-3 py-3"><TourStatusBadge status={tour.status} /></td>
              <td className="px-3 py-3 text-sm">{routeTitle(tour)}</td>
              <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(tour.plannedStartAt)}</td>
              <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(tour.predictedEta)}</td>
              <td className="px-3 py-3 text-sm font-semibold tabular-nums">{formatDelay(tour.predictedDelayMinutes)}</td>
              <td className="px-3 py-3">
                {tour.status === 'QUEUED' || tourCancellable(tour) ? (
                  <div className="flex justify-end gap-2">
                    {tour.status === 'QUEUED' ? <Link className="secondary-button min-h-9 px-2" to={`/tours/${tour.id}/edit`} aria-label={`Изменить заказ ${tour.orderNumber}`}><Pencil className="h-4 w-4" /></Link> : null}
                    {tourCancellable(tour) ? <button className="danger-button min-h-9 px-2" type="button" disabled={cancellingId === tour.id} onClick={() => void cancelTour(tour)} aria-label={`Удалить тур ${tour.orderNumber}`}><XCircle className="h-4 w-4" /></button> : null}
                  </div>
                ) : <span className="text-sm text-slate-400">–</span>}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <EmptyState label="Маршрутов пока нет. Создайте первый заказ на странице «Новый заказ»." />
      )}
      {error ? <ErrorState error={error} onRetry={refetch} /> : null}
      {actionError ? <ErrorState error={actionError} onRetry={refetch} /> : null}
    </div>
  )
}
