import type { DriverEta, DriverStop } from './api'

const zone = { timeZone: 'Europe/Berlin' } as const
const timeFormat = new Intl.DateTimeFormat('de-DE', { ...zone, hour: '2-digit', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat('ru-RU', { ...zone, weekday: 'long', day: '2-digit', month: '2-digit' })
const dayKey = new Intl.DateTimeFormat('en-CA', { ...zone, year: 'numeric', month: '2-digit', day: '2-digit' })
const shortDay = new Intl.DateTimeFormat('de-DE', { ...zone, day: '2-digit', month: '2-digit' })

export const clock = (iso: string) => timeFormat.format(new Date(iso))
export const dayLabel = (iso: string) => dayFormat.format(new Date(iso))
/** «10:30», or «18.11. 10:30» when it is not today. */
export const clockWithDay = (iso: string, nowIso: string) => dayKey.format(new Date(iso)) === dayKey.format(new Date(nowIso)) ? clock(iso) : `${shortDay.format(new Date(iso))} ${clock(iso)}`

export const doneWord = (stop: Pick<DriverStop, 'type'>) => stop.type === 'LOAD' ? 'BELADEN' : 'ENTLADEN'
export const terminOf = (stop: DriverStop) => stop.appointmentAt ?? stop.windowStartAt
export const windowLabel = (stop: DriverStop) => stop.windowStartAt && stop.windowEndAt && stop.windowStartAt !== stop.windowEndAt ? `окно ${clock(stop.windowStartAt)}–${clock(stop.windowEndAt)}` : null

export function minutesText(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes))
  return whole < 60 ? `${whole} мин` : `${Math.floor(whole / 60)} ч ${String(whole % 60).padStart(2, '0')} мин`
}

/** How the ETA stands against the latest moment the stop accepts the truck. */
export function etaMargin(stop: DriverStop, eta: DriverEta | null): { late: boolean; text: string } | null {
  const deadline = stop.windowEndAt ?? stop.appointmentAt
  if (!eta?.at || !deadline) return null
  const minutes = (Date.parse(deadline) - Date.parse(eta.at)) / 60_000
  return minutes >= 0 ? { late: false, text: `запас ${minutesText(minutes)}` } : { late: true, text: `опоздание ${minutesText(-minutes)}` }
}

export const etaSourceText = (eta: DriverEta) => eta.source === 'WEBFLEET' ? 'по GPS Webfleet' : eta.source === 'WEBFLEET_STALE' ? 'GPS Webfleet устарел' : 'расчёт, без GPS'

export function cargoLine(stop: DriverStop): string | null {
  const parts = [stop.loadingMeters !== null ? `${stop.loadingMeters.toLocaleString('de-DE')} LDM` : null, stop.references.length ? `Ref ${stop.references.join(', ')}` : null].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

/** Android offers the installed navigation apps (also truck navigation) for a geo link; elsewhere a web map opens. */
export function navigationLink(stop: DriverStop): string {
  const point = `${stop.latitude},${stop.longitude}`
  return /Android/i.test(navigator.userAgent) ? `geo:${point}?q=${point}(${encodeURIComponent(stop.company ?? stop.address)})` : `https://www.google.com/maps/search/?api=1&query=${point}`
}
