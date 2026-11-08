import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { usePolling } from '../hooks/usePolling'
import { closableWith, isLead, needsAttention, planAlerts, playAlertSound, readDeferred, readSeen, showSummaryAlert, showSystemAlert, stackOf as stackIn, titleWithCount, writeDeferred, writeSeen, type AlertNotification } from '../lib/alerts'
import { readWorkHours, WORK_HOURS_EVENT, type WorkHours } from '../lib/work-hours'
import { onServiceWorkerOpen } from '../lib/pwa'
import { syncPushWorkHours } from '../lib/push'
import { api } from '../lib/api'
import { pendingToDocument } from '../lib/appointments'
import type { PendingAppointment } from '../types/domain'
import { operationsBase, operationsRequest } from '../components/VehicleOperationsPanel'

const HIDDEN_KEY = 'ops-hidden-notifications'
function readHiddenNotifications(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(HIDDEN_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

export type DepartureAnswer = 'done' | 'keep' | 'revert'
export interface Departure { stopType: 'LOAD' | 'UNLOAD'; leftAt: string; time: string }

interface NotificationsState {
  items: AlertNotification[]
  /** One card per truck the dispatcher has not set aside in this tab, most important first. */
  open: AlertNotification[]
  /** The other open notifications of a card's truck, newest first. */
  stackOf: (item: AlertNotification) => AlertNotification[]
  workHours: WorkHours
  acknowledgeAll: (items: AlertNotification[]) => Promise<void>
  pending: PendingAppointment[]
  busyId: string | null
  errors: Record<string, string>
  termin: PendingAppointment | null
  hide: (id: string) => void
  answerDeparture: (item: AlertNotification, answer: DepartureAnswer) => Promise<void>
  resolve: (item: AlertNotification, action: 'ack' | 'revert' | 'revert-event') => Promise<void>
  reviewTermin: (item: AlertNotification) => Promise<void>
  acceptTermin: (item: AlertNotification) => Promise<void>
  closeTermin: (applied: boolean) => Promise<void>
  pendingOf: (item: AlertNotification) => PendingAppointment | null
}

const Context = createContext<NotificationsState | null>(null)

/** One poll for the whole app: the dashboard list, the bell and the toast on other pages read the same items. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  // Keeps polling in a hidden tab so the sound and the Windows notification arrive while the dispatcher is in Outlook or Excel.
  const notifications = usePolling(() => operationsRequest<{ notifications: AlertNotification[] }>('/notifications'), 30000, true, 'notifications', true)
  const pendingPoll = usePolling(api.pendingAppointments, 60_000)
  const navigate = useNavigate()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [termin, setTermin] = useState<{ notification: AlertNotification; item: PendingAppointment } | null>(null)
  // Notifications set aside with «Открыть грузовик» stay aside after a reload in this tab.
  const [hidden, setHidden] = useState<string[]>(readHiddenNotifications)
  useEffect(() => { try { sessionStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden.slice(-200))) } catch { /* Storage may be unavailable. */ } }, [hidden])
  const refetch = notifications.refetch
  const refetchPending = pendingPoll.refetch
  useEffect(() => {
    // Vercel Functions are request-bound; production uses the durable polling path.
    if (!import.meta.env.DEV) return
    const stream = new EventSource(`${operationsBase}/events/stream`)
    stream.addEventListener('operations', refetch)
    stream.addEventListener('open', refetch)
    return () => stream.close()
  }, [refetch])

  // «Открыть» on a notification shown by the service worker lands on the truck in this window.
  useEffect(() => onServiceWorkerOpen((path) => navigate(path)), [navigate])

  const [workHours, setWorkHours] = useState<WorkHours>(readWorkHours)
  useEffect(() => {
    const onChange = () => { setWorkHours(readWorkHours()); void syncPushWorkHours() }
    window.addEventListener(WORK_HOURS_EVENT, onChange)
    return () => window.removeEventListener(WORK_HOURS_EVENT, onChange)
  }, [])
  const items = useMemo(() => notifications.data?.notifications ?? [], [notifications.data])
  // One card, one count and one sound per truck: the truck's other notifications fold under its card.
  const leads = useMemo(() => items.filter(isLead), [items])
  const loaded = notifications.data !== null
  useEffect(() => {
    if (!loaded) return
    document.title = titleWithCount(leads.filter(needsAttention).length)
    // Outside the working day only urgent items ring; the rest wait for one morning summary.
    const plan = planAlerts(leads, readSeen(), readDeferred(), new Date(), readWorkHours())
    writeSeen(plan.seen)
    writeDeferred(plan.deferred)
    const away = document.visibilityState === 'hidden' || !document.hasFocus()
    if (plan.summary) {
      playAlertSound('SUMMARY')
      if (away) showSummaryAlert(plan.summary)
    }
    for (const item of plan.ring) {
      playAlertSound(item.type)
      if (away) showSystemAlert(item, (path) => navigate(path))
    }
  }, [leads, loaded, navigate])
  useEffect(() => () => { document.title = titleWithCount(0) }, [])

  const pending = useMemo(() => (Array.isArray(pendingPoll.data?.items) ? pendingPoll.data.items : []), [pendingPoll.data])
  const open = useMemo(() => leads.filter((item) => !hidden.includes(item.id)), [hidden, leads])
  const stackOf = useCallback((item: AlertNotification) => stackIn(items, item), [items])

  const run = useCallback(async (item: AlertNotification, work: () => Promise<void>) => {
    setBusyId(item.id)
    setErrors((current) => ({ ...current, [item.id]: '' }))
    try { await work() } catch (cause) { setErrors((current) => ({ ...current, [item.id]: cause instanceof Error ? cause.message : 'Не удалось выполнить действие' })) } finally { setBusyId(null) }
  }, [])
  const changed = useCallback(async () => {
    await refetch()
    window.dispatchEvent(new CustomEvent('ops:data-changed'))
  }, [refetch])

  /** The truck left the stop without BELADEN/ENTLADEN: the dispatcher records it, keeps the arrival, or undoes it. */
  const answerDeparture = useCallback(async (item: AlertNotification, answer: DepartureAnswer) => {
    const departure = departureOf(item.payloadJson)
    if (!item.stopId || !departure) return
    const label = departure.stopType === 'LOAD' ? 'BELADEN' : 'ENTLADEN'
    if (answer === 'done' && !window.confirm(`Записать ${label} на ${departure.time}? Это попадёт в историю тура.`)) return
    if (answer === 'revert' && !window.confirm('Прибытие было ошибкой? Точка снова станет «в пути».')) return
    await run(item, async () => {
      if (answer === 'done') await operationsRequest(`/stops/${item.stopId}/${departure.stopType === 'LOAD' ? 'loaded' : 'unloaded'}`, 'POST', { timestamp: departure.leftAt })
      else if (answer === 'keep') await operationsRequest(`/stops/${item.stopId}/departure/keep`, 'POST', {})
      else await operationsRequest(`/stops/${item.stopId}/arrival/revert`, 'POST', { reason: 'Уехала с точки: прибытие было ошибкой' })
      await changed()
    })
  }, [changed, run])

  const resolve = useCallback(async (item: AlertNotification, action: 'ack' | 'revert' | 'revert-event') => {
    if (action === 'revert' && (!item.stopId || !window.confirm('Отменить автоматическое прибытие? Точка снова станет «в пути».'))) return
    if (action === 'revert-event') {
      const label = autoEventOf(item.payloadJson)?.stopType === 'UNLOAD' ? 'ENTLADEN' : 'BELADEN'
      if (!item.stopId || !window.confirm(`Отменить автоматический ${label}? Машина снова будет стоять на точке, в истории останутся обе записи.`)) return
    }
    await run(item, async () => {
      if (action === 'revert') {
        await operationsRequest(`/stops/${item.stopId}/arrival/revert`, 'POST', { reason: 'Отменено из уведомления об автоприбытии' })
        await changed()
        return
      }
      if (action === 'revert-event') {
        await operationsRequest(`/stops/${item.stopId}/auto-event/revert`, 'POST', { reason: 'Отменено из уведомления: машина не загружена или не выгружена' })
        await changed()
        return
      }
      // «Понятно» on a truck's card closes its stack too, except decisions that still wait for their own answer.
      const ids = closableWith(items, item)
      if (ids.length > 1) await operationsRequest('/notifications/ack-many', 'POST', { ids: ids.slice(0, 300) })
      else await operationsRequest(`/notifications/${item.id}/ack`, 'POST')
      await refetch()
    })
  }, [changed, items, refetch, run])

  const findPending = useCallback(async (item: AlertNotification) => {
    const pendingId = pendingIdOf(item)
    const found = (await api.pendingAppointments()).items.find((entry) => entry.id === pendingId)
    if (!found) {
      await operationsRequest(`/notifications/${item.id}/ack`, 'POST')
      await refetch()
      throw new Error('Termin уже привязан или отклонён.')
    }
    return found
  }, [refetch])

  /** A waiting slip found its stop: the same review card as for a fresh document. */
  const reviewTermin = useCallback(async (item: AlertNotification) => {
    await run(item, async () => setTermin({ notification: item, item: await findPending(item) }))
  }, [findPending, run])

  /** «Принять»: attach the slip to the stop the server matched, without opening the review card. */
  const acceptTermin = useCallback(async (item: AlertNotification) => {
    await run(item, async () => {
      const found = await findPending(item)
      const candidate = found.match.status === 'MATCHED' ? found.match.candidates[0] : null
      if (!candidate) { setTermin({ notification: item, item: found }); return }
      if (!window.confirm(`Привязать Termin к LKW ${candidate.vehicleNumber}, Auftrag ${candidate.orderNumber}? ETA и предупреждения пересчитаются.`)) return
      await api.applyAppointmentDocument({ stopId: candidate.stopId, version: candidate.planVersion, fingerprint: found.fingerprint, pendingId: found.id, document: pendingToDocument(found) })
      await operationsRequest(`/notifications/${item.id}/ack`, 'POST').catch(() => undefined)
      await Promise.all([changed(), refetchPending()])
    })
  }, [changed, findPending, refetchPending, run])

  const closeTermin = useCallback(async (applied: boolean) => {
    const current = termin
    setTermin(null)
    if (applied && current) {
      await operationsRequest(`/notifications/${current.notification.id}/ack`, 'POST').catch(() => undefined)
      window.dispatchEvent(new CustomEvent('ops:data-changed'))
    }
    await Promise.all([refetch(), refetchPending()])
  }, [refetch, refetchPending, termin])

  /** «Прочитать все» for the information block; the server closes only items that are still open. */
  const acknowledgeAll = useCallback(async (list: AlertNotification[]) => {
    if (!list.length) return
    setBusyId('all')
    try {
      const ids = [...new Set(list.flatMap((item) => closableWith(items, item)))]
      for (let index = 0; index < ids.length; index += 300) {
        await operationsRequest('/notifications/ack-many', 'POST', { ids: ids.slice(index, index + 300) })
      }
      await refetch()
    } catch (cause) {
      setErrors((current) => ({ ...current, all: cause instanceof Error ? cause.message : 'Не удалось отметить прочитанными' }))
    } finally { setBusyId(null) }
  }, [items, refetch])

  const hide = useCallback((id: string) => setHidden((previous) => [...previous, id]), [])
  const pendingOf = useCallback((item: AlertNotification) => pending.find((entry) => entry.id === pendingIdOf(item)) ?? null, [pending])

  const value = useMemo<NotificationsState>(() => ({
    items, open, stackOf, workHours, acknowledgeAll, pending, busyId, errors, termin: termin?.item ?? null, hide, answerDeparture, resolve, reviewTermin, acceptTermin, closeTermin, pendingOf
  }), [acceptTermin, acknowledgeAll, answerDeparture, busyId, closeTermin, errors, hide, items, open, pending, pendingOf, resolve, reviewTermin, stackOf, termin, workHours])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNotifications() {
  const value = useContext(Context)
  if (!value) throw new Error('useNotifications needs NotificationsProvider')
  return value
}

// eslint-disable-next-line react-refresh/only-export-components
export function departureOf(payloadJson?: string | null): Departure | null {
  try {
    const payload = JSON.parse(payloadJson ?? '{}') as { stopType?: string; leftAt?: string }
    if (!payload.leftAt || (payload.stopType !== 'LOAD' && payload.stopType !== 'UNLOAD')) return null
    const time = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(payload.leftAt))
    return { stopType: payload.stopType, leftAt: payload.leftAt, time }
  } catch { return null }
}

export type AutoStopEvent = { stopType: 'LOAD' | 'UNLOAD'; at: string; time: string; stayMinutes: number | null }

/** BELADEN/ENTLADEN the system recorded after the truck stood at the stop and left the town. */
// eslint-disable-next-line react-refresh/only-export-components
export function autoEventOf(payloadJson?: string | null): AutoStopEvent | null {
  try {
    const payload = JSON.parse(payloadJson ?? '{}') as { stopType?: string; at?: string; stayMinutes?: number }
    if (!payload.at || (payload.stopType !== 'LOAD' && payload.stopType !== 'UNLOAD')) return null
    const time = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(payload.at))
    return { stopType: payload.stopType, at: payload.at, time, stayMinutes: typeof payload.stayMinutes === 'number' ? payload.stayMinutes : null }
  } catch { return null }
}

function pendingIdOf(item: AlertNotification) {
  try { return (JSON.parse(item.payloadJson ?? '{}') as { pendingId?: string }).pendingId ?? null } catch { return null }
}
