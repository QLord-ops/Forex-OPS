import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePolling } from '../hooks/usePolling'
import { localDateTime, operationsBase, operationsRequest } from './VehicleOperationsPanel'

const HIDDEN_KEY = 'ops-hidden-notifications'
function readHiddenNotifications(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(HIDDEN_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

interface Notification { id: string; vehicleId: string; stopId?: string | null; type: string; message: string; createdAt: string }
export function OperationsNotifications() {
  const notifications = usePolling(() => operationsRequest<{ notifications: Notification[] }>('/notifications'), 30000)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [arrival, setArrival] = useState(localDateTime())
  // Notifications set aside with «Открыть грузовик» stay aside after a reload in this tab.
  const [hidden, setHidden] = useState<string[]>(readHiddenNotifications)
  useEffect(() => { try { sessionStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden.slice(-200))) } catch { /* Storage may be unavailable. */ } }, [hidden])
  const [correcting, setCorrecting] = useState(false)
  const [coordinate, setCoordinate] = useState({ latitude: '', longitude: '' })
  useEffect(() => {
    // Vercel Functions are request-bound; production uses the durable polling path.
    if (!import.meta.env.DEV) return
    const stream = new EventSource(`${operationsBase}/events/stream`)
    stream.addEventListener('operations', notifications.refetch)
    stream.addEventListener('open', notifications.refetch)
    return () => stream.close()
  }, [notifications.refetch])
  const current = notifications.data?.notifications.find(item => !hidden.includes(item.id))
  useEffect(() => { setArrival(localDateTime()); setError(''); setCorrecting(false); setCoordinate({ latitude: '', longitude: '' }) }, [current?.id])
  async function resolve(action: 'arrival' | 'not-arrived' | 'ack' | 'revert') {
    if (!current) return
    setBusy(true); setError('')
    try {
      if (action === 'revert') {
        if (!current.stopId || !window.confirm('Отменить автоматическое прибытие? Точка снова станет «в пути».')) return
        await operationsRequest(`/stops/${current.stopId}/arrival/revert`, 'POST', { reason: 'Отменено из уведомления об автоприбытии' })
        await notifications.refetch()
        window.dispatchEvent(new CustomEvent('ops:data-changed'))
        return
      }
      if (action !== 'ack' && current.stopId) await operationsRequest(`/stops/${current.stopId}/${action}`, 'POST', action === 'arrival' ? { arrivedAt: new Date(arrival).toISOString() } : { latitude: Number(coordinate.latitude), longitude: Number(coordinate.longitude) })
      await operationsRequest(`/notifications/${current.id}/ack`, 'POST')
      await notifications.refetch()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  if (!current) return null
  // AUTO_ARRIVAL is an already recorded GPS arrival, not a forecast to confirm.
  const isAuto = current.type === 'AUTO_ARRIVAL'
  const isArrival = !isAuto && (current.type.includes('ARRIVAL') || current.type === 'ARRIVED')
  return <aside role="dialog" aria-labelledby="operations-notification-heading" className="operations-toast fixed bottom-4 left-4 z-50 max-h-[80vh] w-[calc(100%-2rem)] max-w-lg overflow-auto rounded-xl border border-sky-300 bg-white p-5 shadow-xl text-balance-safe">
    <h2 id="operations-notification-heading" className="font-semibold">{current.message}</h2>
    {isAuto && <p className="my-2 text-sm text-slate-600">Прибытие отмечено автоматически: машина стоит в зоне точки по GPS Webfleet. BELADEN/ENTLADEN подтверждаете вы.</p>}
    {isArrival && <><p className="my-2 text-sm text-slate-600">Это прогноз, а не подтверждённое прибытие. Укажите фактическое время.</p><label className="block text-sm">Время прибытия<input className="input" type="datetime-local" value={arrival} onChange={e => setArrival(e.target.value)} /></label></>}
    {error && <p role="alert" className="my-2 text-red-700">{error}</p>}
    {correcting && <form className="my-3 space-y-2" onSubmit={e => { e.preventDefault(); void resolve('not-arrived') }}><p className="text-sm">Укажите текущую позицию — оставшийся путь будет пересчитан.</p><div className="grid grid-cols-2 gap-2">{(['latitude', 'longitude'] as const).map(key => <label className="text-sm" key={key}>{key === 'latitude' ? 'Широта' : 'Долгота'}<input className="input" type="number" step="any" required min={key === 'latitude' ? -90 : -180} max={key === 'latitude' ? 90 : 180} value={coordinate[key]} onChange={e => setCoordinate(previous => ({ ...previous, [key]: e.target.value }))} /></label>)}</div><button className="primary-button" disabled={busy}>Исправить позицию и прогноз</button></form>}
    <div className="mt-3 flex flex-wrap gap-2">{isAuto ? <><button className="primary-button" disabled={busy} onClick={() => void resolve('ack')}>Понятно</button>{current.stopId ? <button className="secondary-button" disabled={busy} onClick={() => void resolve('revert')}>Отменить прибытие</button> : null}</> : isArrival && current.stopId ? <><button className="primary-button" disabled={busy || !arrival} onClick={() => void resolve('arrival')}>Подтвердить прибытие</button><button className="secondary-button" disabled={busy} onClick={() => setCorrecting(!correcting)}>Ещё в пути</button></> : <button className="secondary-button" disabled={busy} onClick={() => void resolve('ack')}>Прочитано</button>}<Link className="secondary-button" to={`/vehicles/${current.vehicleId}`} onClick={() => setHidden(previous => [...previous, current.id])}>Открыть грузовик</Link></div>
  </aside>
}
