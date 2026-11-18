import { getDwellMinutes, terminMargin, vehicleStatus } from './fleet-status'
import { formatTime } from './format'
import { currentStopOf, terminOf } from './tours'
import type { DashboardVehicle } from '../types/domain'

/** Under this reserve the dispatcher is offered to warn the customer (owner, 18.11: «при опоздании»). */
export const NOTICE_RESERVE_MINUTES = 15
/** The dispatchers also write when a truck has waited an hour at the gate (their own letters, 18.11). */
export const NOTICE_WAIT_MINUTES = 60

export type NoticeKind = 'LATE' | 'WAITING'

/** What the dispatcher would tell the customer now: late or tight to the Termin, or waiting at the stop. */
export function noticeKind(row: DashboardVehicle): NoticeKind | null {
  if (!row.tour || !row.customer) return null
  const stop = currentStopOf(row.tour)
  if (!stop || stop.completedAt) return null
  // At the stop (GPS arrival or a stop by hand) the question is the wait, no longer the Termin.
  if (stop.arrivedAt || vehicleStatus(row).tone === 'stop') return getDwellMinutes(row) >= NOTICE_WAIT_MINUTES ? 'WAITING' : null
  if (!row.eta || !terminOf(row.tour)) return null
  const margin = terminMargin(row)
  return margin !== null && margin < NOTICE_RESERVE_MINUTES ? 'LATE' : null
}

export function noticeDue(row: DashboardVehicle): boolean { return noticeKind(row) !== null }

/** «Заказчик уведомлён 13:45, Anna» when the last letter was about the current stop. */
export function noticeLine(row: DashboardVehicle): string | null {
  const notice = row.customerNotice
  const stop = row.tour ? currentStopOf(row.tour) : null
  if (!notice || !stop || notice.stopId !== stop.id) return null
  return `Заказчик уведомлён ${formatTime(notice.at)}, ${notice.by}${notice.channel === 'COPY' ? ' (текст скопирован)' : ''}`
}

const berlinParts = (iso: string) => {
  const parts = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso))
  return { hour: Number(parts.find((part) => part.type === 'hour')?.value ?? 0), minute: parts.find((part) => part.type === 'minute')?.value ?? '00' }
}
/** «12 Uhr» on the hour, «11:55» otherwise — as the dispatchers write the Termin. */
const terminClock = (iso: string) => { const { hour, minute } = berlinParts(iso); return minute === '00' ? `${hour} Uhr` : `${hour}:${minute}` }
const clock = (iso: string) => { const { hour, minute } = berlinParts(iso); return `${String(hour).padStart(2, '0')}:${minute}` }

/** «40 Minuten», «1 Stunde», «2,5 Stunden». */
export function waitText(minutes: number) {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes / 5) * 5)} Minuten`
  const hours = Math.round(minutes / 30) / 2
  return hours === 1 ? '1 Stunde' : `${hours.toLocaleString('de-DE')} Stunden`
}

/** «MB Düsseldorf», «Musterwerk Jena»: the plant as the customer calls it, without the legal form. */
export function placeText(stop: { company?: string | null; city?: string | null; address?: string | null }) {
  const company = (stop.company ?? '').replace(/\b(GmbH|AG|SE|KG|Co\.?|& Co\.?|mbH|Transportlogistik|Logistik)\b/gi, '').replace(/\s+/g, ' ').trim()
  const short = company.length > 24 ? company.split(' ')[0] : company
  const city = (stop.city ?? '').replace(/^\d{4,5}\s+/, '').trim()
  if (!short) return city || stop.address || ''
  return city && !short.toLowerCase().includes(city.toLowerCase()) ? `${short} ${city}` : short
}

/**
 * The letter as the dispatchers write it (owner's Outlook, 18.11): the truck number as the subject and one plain
 * German line; Outlook adds the signature.
 */
export function draftNotice(row: DashboardVehicle, kind: NoticeKind, jam = false) {
  const stop = row.tour ? currentStopOf(row.tour) : null
  const subject = row.vehicle.vehicleNumber
  const action = stop?.type === 'LOAD' ? 'Beladung' : 'Entladung'
  if (kind === 'WAITING') return { subject, body: `Der Fahrer erwartet auf ${action} seit ${waitText(getDwellMinutes(row) || NOTICE_WAIT_MINUTES)}` }
  const termin = terminOf(row.tour)
  const margin = terminMargin(row)
  const place = stop ? placeText(stop) : ''
  const at = termin ? ` um ${terminClock(termin.at)}` : ''
  const where = place ? ` bei ${place}` : ''
  const eta = row.eta ? `, er wird gegen ${clock(row.eta)} Uhr da` : ''
  const cause = jam ? ', er steht im Stau' : ''
  const body = margin !== null && margin < 0
    ? `Hi, der Fahrer hat Verspätung zum Termin${at}${where}${eta}${cause}`
    : `Hi, der Fahrer schafft den Termin${at}${where} knapp${eta}${cause}`
  return { subject, body }
}
