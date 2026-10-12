import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePolling } from '../hooks/usePolling'
import { localDateTime, operationsBase, operationsRequest } from './VehicleOperationsPanel'

interface Notification { id: string; vehicleId: string; stopId?: string | null; type: string; message: string; createdAt: string }
export function OperationsNotifications() {
  const notifications = usePolling(() => operationsRequest<{ notifications: Notification[] }>('/notifications'), 30000)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [arrival, setArrival] = useState(localDateTime())
  const [hidden, setHidden] = useState<string[]>([])
  const [correcting, setCorrecting] = useState(false)
  const [coordinate, setCoordinate] = useState({ latitude: '', longitude: '' })
  useEffect(() => {
    const stream = new EventSource(`${operationsBase}/events/stream`)
    stream.addEventListener('operations', notifications.refetch)
    stream.addEventListener('open', notifications.refetch)
    return () => stream.close()
  }, [notifications.refetch])
  const current = notifications.data?.notifications.find(item => !hidden.includes(item.id))
  useEffect(() => { setArrival(localDateTime()); setError(''); setCorrecting(false); setCoordinate({ latitude: '', longitude: '' }) }, [current?.id])
  async function resolve(action: 'arrival' | 'not-arrived' | 'ack') {
    if (!current) return
    setBusy(true); setError('')
    try {
      if (action !== 'ack' && current.stopId) await operationsRequest(`/stops/${current.stopId}/${action}`, 'POST', action === 'arrival' ? { arrivedAt: new Date(arrival).toISOString() } : { latitude: Number(coordinate.latitude), longitude: Number(coordinate.longitude) })
      await operationsRequest(`/notifications/${current.id}/ack`, 'POST')
      await notifications.refetch()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  if (!current) return null
  const isArrival = current.type.includes('ARRIVAL') || current.type === 'ARRIVED'
  return <aside role="dialog" aria-labelledby="operations-notification-heading" className="fixed bottom-4 right-4 z-50 max-h-[80vh] w-[calc(100%-2rem)] max-w-lg overflow-auto rounded-xl border border-sky-300 bg-white p-5 shadow-xl text-balance-safe">
    <h2 id="operations-notification-heading" className="font-semibold">{current.message}</h2>
    {isArrival && <><p className="my-2 text-sm text-slate-600">Это прогноз, а не подтверждённое прибытие. Укажите фактическое время.</p><label className="block text-sm">Время прибытия<input className="input" type="datetime-local" value={arrival} onChange={e => setArrival(e.target.value)} /></label></>}
    {error && <p role="alert" className="my-2 text-red-700">{error}</p>}
    {correcting && <form className="my-3 space-y-2" onSubmit={e => { e.preventDefault(); void resolve('not-arrived') }}><p className="text-sm">Укажите текущую позицию — оставшийся путь будет пересчитан.</p><div className="grid grid-cols-2 gap-2">{(['latitude', 'longitude'] as const).map(key => <label className="text-sm" key={key}>{key === 'latitude' ? 'Широта' : 'Долгота'}<input className="input" type="number" step="any" required min={key === 'latitude' ? -90 : -180} max={key === 'latitude' ? 90 : 180} value={coordinate[key]} onChange={e => setCoordinate(previous => ({ ...previous, [key]: e.target.value }))} /></label>)}</div><button className="primary-button" disabled={busy}>Исправить позицию и прогноз</button></form>}
    <div className="mt-3 flex flex-wrap gap-2">{isArrival && current.stopId ? <><button className="primary-button" disabled={busy || !arrival} onClick={() => void resolve('arrival')}>Подтвердить прибытие</button><button className="secondary-button" disabled={busy} onClick={() => setCorrecting(!correcting)}>Ещё в пути</button></> : <button className="secondary-button" disabled={busy} onClick={() => void resolve('ack')}>Прочитано</button>}<Link className="secondary-button" to={`/vehicles/${current.vehicleId}`} onClick={() => setHidden(previous => [...previous, current.id])}>Открыть грузовик</Link></div>
  </aside>
}
