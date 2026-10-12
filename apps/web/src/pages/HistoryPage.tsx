import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { DataTable } from '../components/DataTable'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import { formatAppointment, formatDateTime, formatDelay, formatElapsedMinutes, operationEventLabel, statusLabel, stopTypeLabel } from '../lib/format'
import type { Stop, Tour } from '../types/domain'

export function HistoryPage() {
  const vehicles = usePolling(api.vehicles, 30_000)
  const [vehicleId, setVehicleId] = useState('')
  const [now, setNow] = useState(() => new Date())
  const history = usePolling(() => api.history(vehicleId || undefined), 30_000, true, vehicleId || 'all')

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  if ((vehicles.loading || history.loading) && (!vehicles.data || !history.data)) {
    return <LoadingState label="История загружается" />
  }

  if (vehicles.error && !vehicles.data) return <ErrorState error={vehicles.error} onRetry={vehicles.refetch} />
  if (history.error && !history.data) return <ErrorState error={history.error} onRetry={history.refetch} />

  const tours = history.data?.tours ?? []
  const events = history.data?.events ?? []
  const operationEvents = history.data?.operationEvents ?? []
  const timeReports = history.data?.timeReports ?? []

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">История грузовиков</h2>
          <p className="text-sm text-slate-500">
            Маршруты и неизменяемые события загрузки/выгрузки из базы данных · данные на {formatDateTime(history.data?.generatedAt)}
          </p>
        </div>
        <button className="secondary-button" onClick={() => void Promise.all([vehicles.refetch(), history.refetch()])}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Обновить
        </button>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <label className="block max-w-sm">
          <span className="field-label">Фильтр по грузовику</span>
          <select className="field-input" value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}>
            <option value="">Все грузовики</option>
            {vehicles.data?.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicle.vehicleNumber}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Маршруты</h3>
          <p className="text-sm text-slate-600">История заказов с началом, завершением, сроками, ETA и опозданием.</p>
        </div>
        {tours.length ? (
          <DataTable
            columns={[
              'Заказ',
              'Грузовик',
              'Статус',
              'Плановое начало',
              'Фактическое начало',
              'Завершено',
              'Первая загрузка',
              'Срок загрузки',
              'Последняя выгрузка',
              'Срок выгрузки',
              'ETA',
              'Опоздание'
            ]}
          >
            {tours.map((tour) => {
              const firstLoad = findFirstStop(tour, 'LOAD')
              const finalUnload = findFinalStop(tour, 'UNLOAD')

              return (
                <tr key={tour.id} className="hover:bg-slate-50">
                  <td className="px-3 py-3 text-sm font-semibold">{tour.orderNumber}</td>
                  <td className="px-3 py-3 text-lg font-bold tabular-nums">{tour.vehicle?.vehicleNumber ?? tour.vehicleId}</td>
                  <td className="px-3 py-3 text-sm">{statusLabel(tour.status)}</td>
                  <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(tour.plannedStartAt)}</td>
                  <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(tour.actualStartAt)}</td>
                  <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(tour.completedAt)}</td>
                  <td className="px-3 py-3 text-sm">{formatStopAddress(firstLoad)}</td>
                  <td className="px-3 py-3 text-sm tabular-nums">{formatAppointment(firstLoad?.appointmentAt)}</td>
                  <td className="px-3 py-3 text-sm">{formatStopAddress(finalUnload)}</td>
                  <td className="px-3 py-3 text-sm tabular-nums">{formatAppointment(finalUnload?.appointmentAt)}</td>
                  <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(tour.currentEta ?? tour.predictedEta ?? tour.eta)}</td>
                  <td className="px-3 py-3 text-sm font-semibold tabular-nums">
                    {formatDelay(tour.currentDelayMinutes ?? tour.predictedDelayMinutes ?? tour.delayMinutes)}
                  </td>
                </tr>
              )
            })}
          </DataTable>
        ) : (
          <EmptyState label="Для выбранного фильтра маршруты не найдены." />
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">События</h3>
          <p className="text-sm text-slate-600">Неизменяемые события загрузки и выгрузки.</p>
        </div>
        {events.length ? (
          <DataTable columns={['Время', 'Грузовик', 'Заказ', 'Событие', 'Точка', 'Срок', 'Время на точке', 'Примечание']}>
            {events.map((event) => (
              <tr key={event.id} className="hover:bg-slate-50">
                <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(event.timestamp)}</td>
                <td className="px-3 py-3 text-lg font-bold tabular-nums">{event.vehicle?.vehicleNumber ?? event.vehicleId}</td>
                <td className="px-3 py-3 text-sm">{event.tour?.orderNumber ?? event.tourId}</td>
                <td className="px-3 py-3 text-sm font-semibold">{event.type === 'LOADED' ? 'ЗАГРУЖЕНО' : 'ВЫГРУЖЕНО'}</td>
                <td className="px-3 py-3 text-sm">
                  {event.stop ? `${stopTypeLabel(event.stop.type)} · ${event.stop.address}` : event.stopId ?? '–'}
                </td>
                <td className="px-3 py-3 text-sm tabular-nums">{formatAppointment(event.stop?.appointmentAt)}</td>
                <td className="px-3 py-3 text-sm tabular-nums">{formatElapsedMinutes(event.stop?.arrivedAt, event.stop?.completedAt ?? event.timestamp, now)}</td>
                <td className="px-3 py-3 text-sm">{event.note || '–'}</td>
              </tr>
            ))}
          </DataTable>
        ) : (
          <EmptyState label="События не найдены. История появится после подтверждения загрузки или выгрузки." />
        )}
      </section>
      {timeReports.length ? (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Отчёты времени</h3>
            <p className="text-sm text-slate-600">Время от подтверждённого прибытия до завершения загрузки или выгрузки.</p>
          </div>
          <DataTable columns={['Грузовик', 'Заказ', 'Точка', 'Город', 'Прибытие', 'Завершение', 'Длительность']}>
            {timeReports.map((report) => {
              const vehicle = vehicles.data?.find(item => item.id === report.vehicleId)
              const tour = tours.find(item => item.id === report.tourId)
              return (
                <tr key={`${report.stopId}-${report.arrivedAt}`} className="hover:bg-slate-50">
                  <td className="px-3 py-3 text-lg font-bold tabular-nums">{vehicle?.vehicleNumber ?? report.vehicleId}</td>
                  <td className="px-3 py-3 text-sm">{tour?.orderNumber ?? report.tourId}</td>
                  <td className="px-3 py-3 text-sm">{stopTypeLabel(report.type)}</td>
                  <td className="px-3 py-3 text-sm">{report.city || 'Город неизвестен'}</td>
                  <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(report.arrivedAt)}</td>
                  <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(report.completedAt)}</td>
                  <td className="px-3 py-3 text-sm font-semibold tabular-nums">{formatElapsedMinutes(report.arrivedAt, report.completedAt, now)}</td>
                </tr>
              )
            })}
          </DataTable>
        </section>
      ) : null}
      {operationEvents.length ? (
        <section className="space-y-3">
          <div><h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Журнал изменений</h3><p className="text-sm text-slate-600">Корректировки времени грузовика, маршрута и рабочего состояния с указанием причины.</p></div>
          <DataTable columns={['Время', 'Грузовик', 'Заказ', 'Тип', 'Причина']}>
            {operationEvents.map(event => <tr key={event.id} className="hover:bg-slate-50">
              <td className="px-3 py-3 text-sm tabular-nums">{formatDateTime(event.createdAt ?? event.timestamp)}</td>
              <td className="px-3 py-3 text-sm">{vehicles.data?.find(item => item.id === event.vehicleId)?.vehicleNumber ?? event.vehicleId}</td>
              <td className="px-3 py-3 text-sm">{tours.find(item => item.id === event.tourId)?.orderNumber ?? event.tourId ?? '–'}</td>
              <td className="px-3 py-3 text-sm font-semibold">{operationEventLabel(event.type)}</td>
              <td className="px-3 py-3 text-sm">{event.reason || '–'}</td>
            </tr>)}
          </DataTable>
        </section>
      ) : null}
      {history.error ? <ErrorState error={history.error} onRetry={history.refetch} /> : null}
    </div>
  )
}

function findFirstStop(tour: Tour, type: Stop['type']): Stop | undefined {
  return tour.stops?.slice().sort((a, b) => a.sequence - b.sequence).find((stop) => stop.type === type)
}

function findFinalStop(tour: Tour, type: Stop['type']): Stop | undefined {
  return tour.stops?.slice().sort((a, b) => b.sequence - a.sequence).find((stop) => stop.type === type)
}

function formatStopAddress(stop?: Stop): string {
  if (!stop) return '–'
  return stop.city?.trim() || 'Город неизвестен'
}
