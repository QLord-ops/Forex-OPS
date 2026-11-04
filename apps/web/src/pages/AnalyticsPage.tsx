import { Link } from 'react-router-dom'

import { DataTable } from '../components/DataTable'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import { getDwellMinutes, matchesFleetFilter, terminToday, vehicleStatus } from '../lib/fleet-status'
import { formatDurationMinutes, formatTime, shortAddress } from '../lib/format'
import { terminOf } from '../lib/tours'
import { HistoryPage } from './HistoryPage'

/** Today's fleet in figures, then the delays and the event history. Everything comes from the dashboard data. */
export function AnalyticsPage() {
  const { data, error, loading, refetch } = usePolling(api.dashboard, 60_000)
  if (loading && !data) return <LoadingState label="Аналитика загружается" />
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />
  const rows = data?.vehicles ?? []
  const late = rows.filter((row) => vehicleStatus(row).tone === 'late').sort((a, b) => (b.delayMinutes ?? 0) - (a.delayMinutes ?? 0))
  const longStops = rows.filter((row) => getDwellMinutes(row) > 60)
  const stats = [
    { label: 'Машин в парке', value: rows.length, note: `${rows.filter((row) => matchesFleetFilter(row, 'IDLE')).length} без тура` },
    { label: 'В пути', value: rows.filter((row) => matchesFleetFilter(row, 'MOVING')).length, note: 'по Webfleet и расчёту' },
    { label: 'На точке', value: rows.filter((row) => matchesFleetFilter(row, 'AT_STOP')).length, note: `${longStops.length} дольше часа` },
    { label: 'Termin сегодня', value: rows.filter((row) => terminToday(row)).length, note: `${rows.filter((row) => terminOf(row.tour)).length} всего с Termin` },
    { label: 'Опаздывают', value: late.length, note: late.length ? `до ${formatDurationMinutes(late[0]?.delayMinutes ?? 0)}` : 'опозданий нет' }
  ]
  return (
    <div className="space-y-6">
      <div className="page-header">
        <div className="min-w-0">
          <h2 className="page-title">Аналитика</h2>
          <p className="page-subtitle">Парк сейчас, опоздания и история событий · обновлено {formatTime(data?.generatedAt ?? new Date().toISOString())}</p>
        </div>
        <Link className="secondary-button" to="/alerts">Предупреждения по срокам</Link>
      </div>
      <dl className="stat-row">
        {stats.map((item) => <div key={item.label} className="stat-tile"><dt>{item.label}</dt><dd>{item.value}</dd><span>{item.note}</span></div>)}
      </dl>
      <section aria-labelledby="analytics-late" className="space-y-3">
        <h3 id="analytics-late" className="section-title">Опоздания сейчас</h3>
        {late.length ? <DataTable columns={['Машина', 'Auftrag', 'Куда', 'Termin', 'ETA', 'Опоздание']}>
          {late.map((row) => {
            const termin = terminOf(row.tour)
            return <tr key={row.vehicle.id}>
              <td className="px-3 py-2 font-semibold tabular-nums"><Link className="hover:underline" to={`/?vehicleId=${row.vehicle.id}`}>LKW {row.vehicle.vehicleNumber}</Link></td>
              <td className="px-3 py-2 text-sm">{row.tour?.orderNumber ?? '–'}</td>
              <td className="px-3 py-2 text-sm">{shortAddress(row.to)}</td>
              <td className="px-3 py-2 text-sm tabular-nums">{termin?.label.replace(/^Termin /, '') ?? '–'}</td>
              <td className="px-3 py-2 text-sm tabular-nums">{row.eta ? formatTime(row.eta) : '–'}</td>
              <td className="px-3 py-2 text-sm font-semibold text-red-700 tabular-nums">+{formatDurationMinutes(row.delayMinutes ?? 0)}</td>
            </tr>
          })}
        </DataTable> : <EmptyState label="Сейчас никто не опаздывает." />}
      </section>
      <HistoryPage />
    </div>
  )
}
