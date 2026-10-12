import { AlertTriangle, ArrowUpRight, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'

import { DataTable } from '../components/DataTable'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { RiskBadge } from '../components/StatusBadge'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import { formatAppointment, formatDateTime, formatDelay, formatKm, shortAddress, statusLabel } from '../lib/format'

export function DashboardPage() {
  const { data, error, loading, refetch } = usePolling(api.dashboard, 30_000)

  if (loading && !data) return <LoadingState />
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />

  const vehicles = data?.vehicles ?? []
  const risks = data?.riskyAppointments ?? []

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Панель управления</h2>
          <p className="text-sm text-slate-500">
            Обновлено {formatDateTime(data?.generatedAt)} · автоматическое обновление каждые 30 секунд
          </p>
        </div>
        <button className="secondary-button" onClick={refetch}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Обновить
        </button>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Сроки под угрозой</h3>
            <p className="text-sm text-slate-600">Сортировка по ожидаемому опозданию</p>
          </div>
          <AlertTriangle className="h-5 w-5 text-orange-500" aria-hidden="true" />
        </div>
        {risks.length ? (
          <div className="divide-y divide-slate-100">
            {risks
              .slice()
              .sort((a, b) => b.delayMinutes - a.delayMinutes)
              .map((risk) => (
                <Link
                  key={`${risk.vehicle.id}-${risk.stop.id}`}
                  to={`/vehicles/${risk.vehicle.id}`}
                  className="grid gap-3 px-4 py-3 text-sm hover:bg-slate-50 md:grid-cols-[100px_140px_1fr_180px_180px_120px] md:items-center"
                >
                  <span className="text-lg font-bold tabular-nums">{risk.vehicle.vehicleNumber}</span>
                  <span className="font-semibold">{risk.tour?.orderNumber ?? '–'} · {statusLabel(risk.tour?.status)}</span>
                  <span>{shortAddress(risk.stop)}</span>
                  <span>Срок {formatAppointment(risk.stop.appointmentAt)}</span>
                  <span>ETA {formatDateTime(risk.eta)}</span>
                  <span className="font-bold text-red-700">{formatDelay(risk.delayMinutes)}</span>
                </Link>
              ))}
          </div>
        ) : (
          <EmptyState label="По текущим данным сроки не находятся под угрозой." />
        )}
      </section>

      {vehicles.length ? (
        <DataTable columns={['Грузовик', 'Текущий статус', 'Откуда', 'Куда', 'Срок', 'ETA', 'Пройдено', 'Осталось', 'Опоздание', 'Риск', '']}>
          {vehicles.map((row) => (
            <tr key={row.vehicle.id} className="hover:bg-slate-50">
              <td className="whitespace-nowrap px-3 py-3 text-lg font-bold tabular-nums">
                {row.vehicle.vehicleNumber}
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-sm font-medium">{statusLabel(row.statusText)}</td>
              <td className="whitespace-nowrap px-3 py-3 text-sm">{shortAddress(row.from)}</td>
              <td className="whitespace-nowrap px-3 py-3 text-sm">{shortAddress(row.to)}</td>
              <td className="whitespace-nowrap px-3 py-3 text-sm tabular-nums">{formatAppointment(row.appointmentAt)}</td>
              <td className="whitespace-nowrap px-3 py-3 text-sm tabular-nums">{formatDateTime(row.eta)}</td>
              <td className="whitespace-nowrap px-3 py-3 text-sm tabular-nums">{formatKm(row.travelledKm)}</td>
              <td className="whitespace-nowrap px-3 py-3 text-sm tabular-nums">{formatKm(row.remainingKm)}</td>
              <td className="whitespace-nowrap px-3 py-3 text-sm font-semibold tabular-nums">{formatDelay(row.delayMinutes)}</td>
              <td className="whitespace-nowrap px-3 py-3">
                <RiskBadge risk={row.risk} />
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-right">
                <Link className="secondary-button min-h-9 px-2" to={`/vehicles/${row.vehicle.id}`} aria-label={`Открыть грузовик ${row.vehicle.vehicleNumber}`}>
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </td>
            </tr>
          ))}
        </DataTable>
      ) : (
        <EmptyState label="Грузовиков пока нет. Новый грузовик можно добавить на странице «Грузовики»." />
      )}

      {error ? <ErrorState error={error} onRetry={refetch} /> : null}
    </div>
  )
}
