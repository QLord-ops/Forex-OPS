/**
 * Alerts that reach the dispatcher outside the OPS tab: a sound, a Windows notification and a count in the tab title.
 * They work while OPS is open in a browser tab, also in the background.
 */
import { isWorkTime, lastShiftEnd, type WorkHours } from './work-hours'

export type AlertPriority = 'ACTION' | 'RISK' | 'INFO'
export interface AlertNotification {
  id: string; vehicleId: string; stopId?: string | null; type: string; message: string; createdAt: string; payloadJson?: string | null
  /** Set by the server: decisions first, then risks, then information. */
  priority?: AlertPriority
  /** Rings also outside the working day: left without BELADEN/ENTLADEN, critical stop. */
  urgent?: boolean
  /** No longer applies (BELADEN done, a newer jam); stays until the dispatcher reads it. */
  resolved?: boolean
  resolvedReason?: string | null
}

/** Counts in the title and on the bell: only what still asks for the dispatcher. */
export const needsAttention = (item: AlertNotification) => !item.resolved && item.priority !== 'INFO'

const SEEN_KEY = 'ops-alerted-notifications'
const SOUND_KEY = 'ops-alert-sound'
const BANNER_KEY = 'ops-alert-banner-dismissed'
const DEFERRED_KEY = 'ops-deferred-alerts'
export const BASE_TITLE = 'OPS FOREX'

export type AlertPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export function alertPermission(): AlertPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return window.Notification.permission
}

export async function requestAlertPermission(): Promise<AlertPermission> {
  if (alertPermission() === 'unsupported') return 'unsupported'
  unlockSound()
  try { return await window.Notification.requestPermission() } catch { return alertPermission() }
}

export function soundEnabled() {
  try { return window.localStorage.getItem(SOUND_KEY) !== 'off' } catch { return true }
}

export function setSoundEnabled(on: boolean) {
  try { window.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off') } catch { /* per-viewer convenience only */ }
  if (on) unlockSound()
}

export function bannerDismissed() {
  try { return window.localStorage.getItem(BANNER_KEY) === '1' } catch { return false }
}

export function dismissBanner() {
  try { window.localStorage.setItem(BANNER_KEY, '1') } catch { /* per-viewer convenience only */ }
}

export function readSeen(): string[] | null {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(SEEN_KEY) ?? 'null')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null
  } catch { return null }
}

export function writeSeen(ids: string[]) {
  try { window.sessionStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-300))) } catch { /* storage may be unavailable */ }
}

/**
 * Which notifications should ring now. On the first poll of a tab nothing older rings one by one:
 * the backlog becomes one summary, so a reload does not set off a dozen sounds.
 */
export function pickNewAlerts(items: AlertNotification[], seen: string[] | null) {
  if (seen === null) return { fresh: [] as AlertNotification[], summary: items.length, seen: items.map((item) => item.id) }
  const known = new Set(seen)
  const fresh = items.filter((item) => !known.has(item.id))
  return { fresh, summary: 0, seen: [...seen, ...fresh.map((item) => item.id)] }
}

export function readDeferred(): string[] {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(DEFERRED_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

export function writeDeferred(ids: string[]) {
  try { window.sessionStorage.setItem(DEFERRED_KEY, JSON.stringify(ids.slice(-300))) } catch { /* storage may be unavailable */ }
}

/** Notifications that came after the last working day ended, while the dispatcher was away. */
export function nightItems(items: AlertNotification[], hours: WorkHours, now = new Date()) {
  if (!isWorkTime(now, hours)) return []
  const since = lastShiftEnd(now, hours)
  return items.filter((item) => {
    const at = new Date(item.createdAt)
    return (!since || at > since) && !isWorkTime(at, hours)
  })
}

export interface AlertPlan {
  ring: AlertNotification[]
  /** One summary instead of many sounds: the backlog on the first poll, or what waited through the night. */
  summary: { total: number; decisions: number; night: boolean } | null
  seen: string[]
  deferred: string[]
}

/**
 * Which notifications ring now. Outside the working day only urgent ones ring; the rest wait silently
 * and the first poll of the working day gives one summary of them.
 */
export function planAlerts(items: AlertNotification[], seen: string[] | null, deferred: string[], now: Date, hours: WorkHours): AlertPlan {
  const working = isWorkTime(now, hours)
  const open = new Set(items.map((item) => item.id))
  const summaryOf = (list: AlertNotification[], night: boolean) => list.length
    ? { total: list.length, decisions: list.filter((item) => needsAttention(item) && item.priority === 'ACTION').length, night }
    : null
  if (seen === null) {
    const ids = items.map((item) => item.id)
    if (working) return { ring: [], summary: summaryOf(items.filter(needsAttention), false), seen: ids, deferred: [] }
    const urgent = items.filter((item) => item.urgent && needsAttention(item))
    return { ring: [], summary: summaryOf(urgent, false), seen: ids, deferred: items.filter((item) => !urgent.includes(item)).map((item) => item.id) }
  }
  const known = new Set(seen)
  const fresh = items.filter((item) => !known.has(item.id) && !item.resolved)
  const nextSeen = [...seen, ...items.filter((item) => !known.has(item.id)).map((item) => item.id)]
  if (working) {
    const waited = items.filter((item) => deferred.includes(item.id))
    return { ring: fresh, summary: summaryOf(waited, true), seen: nextSeen, deferred: [] }
  }
  const ring = fresh.filter((item) => item.urgent)
  const quiet = fresh.filter((item) => !item.urgent).map((item) => item.id)
  return { ring, summary: null, seen: nextSeen, deferred: [...deferred.filter((id) => open.has(id)), ...quiet] }
}

export function titleWithCount(count: number) {
  return count > 0 ? `(${count > 99 ? '99+' : count}) ${BASE_TITLE}` : BASE_TITLE
}

export function alertHeading(type: string) {
  if (type === 'AUTO_ARRIVAL') return 'Прибытие по GPS'
  if (type === 'TRAFFIC_DELAY') return 'Пробка на маршруте'
  if (type === 'LONG_DWELL') return 'Долгая стоянка'
  if (type === 'APPOINTMENT_MATCH') return 'Термин нашёл свой тур'
  if (type === 'STOP_DEPARTED') return 'Машина уехала с точки'
  if (type === 'ROUTE_DEVIATION') return 'Отклонение от маршрута'
  if (type === 'TERMIN_MET') return 'Прибытие к Termin'
  if (type === 'PREVIOUS_TOUR_OPEN') return 'Прошлый тур не закрыт'
  return 'Уведомление OPS'
}

export function cardLink(vehicleId: string) {
  const id = encodeURIComponent(vehicleId)
  return `/?vehicleId=${id}&card=${id}`
}

export function showSystemAlert(item: AlertNotification, onOpen: (path: string) => void) {
  if (alertPermission() !== 'granted') return null
  try {
    // One window per notification id; requireInteraction keeps it on screen until the dispatcher reacts.
    const shown = new window.Notification(alertHeading(item.type), { body: item.message, tag: item.id, requireInteraction: true })
    shown.onclick = () => { window.focus(); onOpen(cardLink(item.vehicleId)); shown.close() }
    return shown
  } catch { return null }
}

export function summaryText(summary: { total: number; decisions: number; night: boolean }) {
  const head = summary.night ? `За ночь: ${summary.total}` : `Непрочитанных уведомлений: ${summary.total}`
  return summary.decisions ? `${head} · требуют решения: ${summary.decisions}` : head
}

export function showSummaryAlert(summary: { total: number; decisions: number; night: boolean }) {
  if (alertPermission() !== 'granted' || summary.total <= 0) return
  try { new window.Notification(BASE_TITLE, { body: summaryText(summary), tag: 'ops-summary' }).onclick = () => window.focus() } catch { /* ignore */ }
}

let audio: AudioContext | null = null

/** Browsers start audio only after a click; the first click in OPS prepares it. */
export function unlockSound() {
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Context) return
    audio ??= new Context()
    if (audio.state === 'suspended') void audio.resume()
  } catch { /* sound is optional */ }
}

/** Two tones for an arrival, three lower ones for traffic or a long stop. Generated, so no sound file and no CSP change. */
export function playAlertSound(type: string) {
  if (!soundEnabled()) return
  unlockSound()
  if (!audio) return
  const tones = type === 'AUTO_ARRIVAL' ? [880, 1175] : type === 'STOP_DEPARTED' ? [1175, 880, 1175] : [660, 660, 520]
  const start = audio.currentTime + 0.02
  tones.forEach((frequency, index) => {
    const oscillator = audio!.createOscillator()
    const gain = audio!.createGain()
    const at = start + index * 0.22
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18)
    oscillator.connect(gain).connect(audio!.destination)
    oscillator.start(at)
    oscillator.stop(at + 0.2)
  })
}
