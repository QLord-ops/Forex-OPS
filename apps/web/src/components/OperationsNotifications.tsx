import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { usePolling } from '../hooks/usePolling'
import {
  alertPermission, bannerDismissed, dismissBanner, pickNewAlerts, playAlertSound, readSeen, requestAlertPermission,
  showSummaryAlert, showSystemAlert, titleWithCount, writeSeen, type AlertNotification, type AlertPermission
} from '../lib/alerts'
import { api } from '../lib/api'
import { pendingToDocument } from '../lib/appointments'
import type { PendingAppointment } from '../types/domain'
import { AppointmentReview } from './AppointmentReview'
import { operationsBase, operationsRequest } from './VehicleOperationsPanel'

const HIDDEN_KEY = 'ops-hidden-notifications'
function readHiddenNotifications(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(HIDDEN_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

export function OperationsNotifications() {
  // Keeps polling in a hidden tab so the sound and the Windows notification arrive while the dispatcher is in Outlook or Excel.
  const notifications = usePolling(() => operationsRequest<{ notifications: AlertNotification[] }>('/notifications'), 30000, true, 'notifications', true)
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [permission, setPermission] = useState<AlertPermission>(alertPermission)
  const [banner, setBanner] = useState(() => !bannerDismissed())
  const [termin, setTermin] = useState<PendingAppointment | null>(null)
  // Notifications set aside with «Открыть грузовик» stay aside after a reload in this tab.
  const [hidden, setHidden] = useState<string[]>(readHiddenNotifications)
  useEffect(() => { try { sessionStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden.slice(-200))) } catch { /* Storage may be unavailable. */ } }, [hidden])
  useEffect(() => {
    // Vercel Functions are request-bound; production uses the durable polling path.
    if (!import.meta.env.DEV) return
    const stream = new EventSource(`${operationsBase}/events/stream`)
    stream.addEventListener('operations', notifications.refetch)
    stream.addEventListener('open', notifications.refetch)
    return () => stream.close()
  }, [notifications.refetch])

  const items = notifications.data?.notifications
  useEffect(() => {
    if (!items) return
    document.title = titleWithCount(items.length)
    const { fresh, summary, seen } = pickNewAlerts(items, readSeen())
    writeSeen(seen)
    const away = document.visibilityState === 'hidden' || !document.hasFocus()
    if (summary > 0) {
      playAlertSound('SUMMARY')
      if (away) showSummaryAlert(summary)
    }
    for (const item of fresh) {
      playAlertSound(item.type)
      if (away) showSystemAlert(item, (path) => navigate(path))
    }
  }, [items, navigate])
  useEffect(() => () => { document.title = titleWithCount(0) }, [])

  const current = items?.find(item => !hidden.includes(item.id))
  useEffect(() => { setError('') }, [current?.id])

  /** A waiting slip found its stop: the same review card as for a fresh document. */
  async function openTermin() {
    if (!current) return
    setBusy(true); setError('')
    try {
      const pendingId = (JSON.parse(current.payloadJson ?? '{}') as { pendingId?: string }).pendingId
      const item = (await api.pendingAppointments()).items.find((entry) => entry.id === pendingId)
      if (!item) { await operationsRequest(`/notifications/${current.id}/ack`, 'POST'); await notifications.refetch(); setError('Термин уже привязан или отклонён.'); return }
      setTermin(item)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function closeTermin(applied: boolean) {
    setTermin(null)
    if (applied && current) { await operationsRequest(`/notifications/${current.id}/ack`, 'POST').catch(() => undefined); window.dispatchEvent(new CustomEvent('ops:data-changed')) }
    await notifications.refetch()
  }
  async function enableAlerts() {
    setPermission(await requestAlertPermission())
  }
  /** The truck left the stop without BELADEN/ENTLADEN: the dispatcher records it, keeps the arrival, or undoes it. */
  async function answerDeparture(answer: 'done' | 'keep' | 'revert') {
    if (!current?.stopId || !departure) return
    const label = departure.stopType === 'LOAD' ? 'BELADEN' : 'ENTLADEN'
    if (answer === 'done' && !window.confirm(`Записать ${label} на ${departure.time}? Это попадёт в историю тура.`)) return
    if (answer === 'revert' && !window.confirm('Прибытие было ошибкой? Точка снова станет «в пути».')) return
    setBusy(true); setError('')
    try {
      if (answer === 'done') await operationsRequest(`/stops/${current.stopId}/${departure.stopType === 'LOAD' ? 'loaded' : 'unloaded'}`, 'POST', { timestamp: departure.leftAt })
      else if (answer === 'keep') await operationsRequest(`/stops/${current.stopId}/departure/keep`, 'POST', {})
      else await operationsRequest(`/stops/${current.stopId}/arrival/revert`, 'POST', { reason: 'Уехала с точки: прибытие было ошибкой' })
      await notifications.refetch()
      window.dispatchEvent(new CustomEvent('ops:data-changed'))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function resolve(action: 'ack' | 'revert') {
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
      await operationsRequest(`/notifications/${current.id}/ack`, 'POST')
      await notifications.refetch()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const askPermission = permission === 'default' && banner
  if (termin) return <div className="appointment-review-overlay" role="dialog" aria-modal="true" aria-label="Проверка термина">
    <AppointmentReview document={pendingToDocument(termin)} fingerprint={termin.fingerprint} match={termin.match} pendingId={termin.id} fileName="Ожидающий термин"
      onApplied={() => void closeTermin(true)} onSaved={() => void closeTermin(false)} onSkip={() => void closeTermin(false)} />
  </div>
  if (!current && !askPermission) return null
  // AUTO_ARRIVAL is an already recorded GPS arrival: the dispatcher only acknowledges it or undoes a wrong one.
  const isAuto = current?.type === 'AUTO_ARRIVAL'
  const departure = current?.type === 'STOP_DEPARTED' ? departureOf(current.payloadJson) : null
  return <aside role="dialog" aria-labelledby="operations-notification-heading" className="operations-toast fixed bottom-4 left-4 z-50 max-h-[80vh] w-[calc(100%-2rem)] max-w-lg overflow-auto rounded-xl border border-sky-300 bg-white p-5 shadow-xl text-balance-safe">
    {askPermission ? <div className={current ? 'mb-3 border-b border-slate-200 pb-3' : ''}>
      <h2 id={current ? undefined : 'operations-notification-heading'} className="font-semibold">Включите уведомления, чтобы не пропустить прибытие</h2>
      <p className="my-2 text-sm text-slate-600">Со звуком и окном Windows поверх других программ, пока вкладка OPS открыта.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="primary-button" onClick={() => void enableAlerts()}>Включить</button>
        <button type="button" className="secondary-button" onClick={() => { dismissBanner(); setBanner(false) }}>Не сейчас</button>
      </div>
    </div> : null}
    {current ? <>
      <h2 id="operations-notification-heading" className="font-semibold">{current.message}</h2>
      {isAuto && <p className="my-2 text-sm text-slate-600">Прибытие отмечено автоматически: машина стоит в зоне точки по GPS Webfleet. BELADEN/ENTLADEN подтверждаете вы.</p>}
      {error && <p role="alert" className="my-2 text-red-700">{error}</p>}
      {departure && <p className="my-2 text-sm text-slate-600">Машина выехала из зоны точки по GPS Webfleet. Если {departure.stopType === 'LOAD' ? 'загрузка' : 'выгрузка'} была, подтвердите её — время возьмётся по выезду.</p>}
      <div className="mt-3 flex flex-wrap gap-2">{departure
        ? <><button className="primary-button" disabled={busy} onClick={() => void answerDeparture('done')}>{departure.stopType === 'LOAD' ? 'BELADEN' : 'ENTLADEN'} {departure.time}</button>
          <button className="secondary-button" disabled={busy} onClick={() => void answerDeparture('keep')}>{departure.stopType === 'LOAD' ? 'Ещё не загружена' : 'Ещё не выгружена'}</button>
          <button className="secondary-button" disabled={busy} onClick={() => void answerDeparture('revert')}>Прибытие было ошибкой</button></>
        : isAuto
        ? <><button className="primary-button" disabled={busy} onClick={() => void resolve('ack')}>Понятно</button>{current.stopId ? <button className="secondary-button" disabled={busy} onClick={() => void resolve('revert')}>Отменить прибытие</button> : null}</>
        : current.type === 'APPOINTMENT_MATCH'
          ? <><button className="primary-button" disabled={busy} onClick={() => void openTermin()}>Проверить термин</button><button className="secondary-button" disabled={busy} onClick={() => void resolve('ack')}>Позже</button></>
          : <button className="secondary-button" disabled={busy} onClick={() => void resolve('ack')}>Прочитано</button>}
        <Link className="secondary-button" to={`/vehicles/${current.vehicleId}`} onClick={() => setHidden(previous => [...previous, current.id])}>Открыть грузовик</Link></div>
    </> : null}
  </aside>
}

function departureOf(payloadJson?: string | null) {
  try {
    const payload = JSON.parse(payloadJson ?? '{}') as { stopType?: string; leftAt?: string }
    if (!payload.leftAt || (payload.stopType !== 'LOAD' && payload.stopType !== 'UNLOAD')) return null
    const time = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(payload.leftAt))
    return { stopType: payload.stopType, leftAt: payload.leftAt, time }
  } catch { return null }
}
