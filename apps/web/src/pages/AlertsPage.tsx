import { RefreshCw } from 'lucide-react'

import { DataTable } from '../components/DataTable'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import { formatDateTime, formatDelay, shortAddress } from '../lib/format'

export function AlertsPage() {
  const { data, error, loading, refetch } = usePolling(api.alerts, 30_000)

  if (loading && !data) return <LoadingState label="Предупреждения загружаются" />
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />

  const alerts = data ?? []

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div className="min-w-0">
          <h2 className="page-title">Предупреждения</h2>
          <p className="page-subtitle">Одно уведомление на точку для каждого уровня: за два часа и за один час</p>
        </div>
        <button className="secondary-button" onClick={refetch}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Обновить
        </button>
      </div>

      {alerts.length ? (
        <DataTable columns={['Уровень', 'Грузовик', 'Заказ', 'Пункт назначения', 'Срок', 'ETA', 'Опоздание', 'Создано', 'Статус']}>
          {alerts.map((alert) => (
            <tr key={alert.id} className={alert.type === 'ONE_HOUR' ? 'bg-red-50/60 hover:bg-red-50' : 'hover:bg-slate-50'}>
              <td className="px-3 py-3">
                <span className={alert.type === 'ONE_HOUR' ? 'badge border-red-200 bg-red-100 text-red-800' : 'badge border-orange-200 bg-orange-50 text-orange-900'}>
                  {alert.type === 'ONE_HOUR' ? 'СРОЧНО' : 'ПРЕДУПРЕЖДЕНИЕ — 2 Ч'}
                </span>
              </td>
              <td className="px-3 py-3 text-lg font-bold tabular-nums">{alert.vehicle?.vehicleNumber ?? alert.vehicleId}</td>
              <td className="px-3 py-3 text-sm">{alert.tour?.orderNumber ?? alert.tourId}</td>
              <td className="px-3 py-3 text-sm">{shortAddress(alert.stop)}</td>
              <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(alert.appointmentAt)}</td>
              <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(alert.predictedEta)}</td>
              <td className="px-3 py-3 text-sm font-bold text-red-700 tabular-nums">{formatDelay(alert.predictedLateMinutes)}</td>
              <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(alert.createdAt)}</td>
              <td className="px-3 py-3 text-sm">{alert.resolvedAt ? `Закрыто ${formatDateTime(alert.resolvedAt)}` : 'Открыто'}</td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <EmptyState label="Открытых или сохранённых предупреждений нет." />
      )}
      {error ? <ErrorState error={error} onRetry={refetch} /> : null}
    </div>
  )
}
