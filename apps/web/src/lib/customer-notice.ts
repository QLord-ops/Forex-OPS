import { getDwellMinutes, terminMargin, vehicleStatus } from './fleet-status'
import { formatTime, placeName } from './format'
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

const berlinParts = (iso: string | number) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((part) => [part.type, part.value]))
  return { hour: Number(parts.hour ?? 0), minute: parts.minute ?? '00', day: `${parts.day}.${parts.month}.`, date: `${parts.year}-${parts.month}-${parts.day}` }
}
/** «12 Uhr» on the hour, «11:55 Uhr» otherwise — as the dispatchers write the Termin. */
const terminClock = (iso: string) => { const { hour, minute } = berlinParts(iso); return minute === '00' ? `${hour} Uhr` : `${hour}:${minute} Uhr` }
const clock = (iso: string) => { const { hour, minute } = berlinParts(iso); return `${String(hour).padStart(2, '0')}:${minute} Uhr` }
/** Nothing for today, «morgen », «am 19.11. » for a later day: a time after midnight is not read as today's. */
function dayWord(iso: string, now: number) {
  const day = berlinParts(iso)
  if (day.date === berlinParts(now).date) return ''
  return day.date === berlinParts(now + 86_400_000).date ? 'morgen ' : `am ${day.day} `
}

/** «40 Minuten», «1 Stunde», «2,5 Stunden». */
export function waitText(minutes: number) {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes / 5) * 5)} Minuten`
  const hours = Math.round(minutes / 30) / 2
  return hours === 1 ? '1 Stunde' : `${hours.toLocaleString('de-DE')} Stunden`
}

/** «MB Düsseldorf», «Musterwerk Jena»: the plant as the customer calls it, without the legal form or the postcode. */
export function placeText(stop: { company?: string | null; city?: string | null; address?: string | null }) {
  return placeName(stop, false) || stop.address || ''
}

/** «Ждёт на точке» is true only for a truck that stands at its stop; a letter about a truck on the road never says it. */
export function waitsAtStop(row: DashboardVehicle): boolean {
  const stop = row.tour ? currentStopOf(row.tour) : null
  return Boolean(stop && !stop.completedAt && (stop.arrivedAt || vehicleStatus(row).tone === 'stop'))
}

/**
 * The letter as the dispatchers write it (owner's Outlook, 18.11): the truck number as the subject and one plain line;
 * Outlook adds the signature. Whole sentences in German (owner, 18.11): «wartet seit … auf die Entladung», the day with a
 * time that is not today, and the wait only as long as it was really measured.
 */
export function draftNotice(row: DashboardVehicle, kind: NoticeKind, jam = false, now = Date.now()) {
  const stop = row.tour ? currentStopOf(row.tour) : null
  const subject = row.vehicle.vehicleNumber
  const place = stop ? placeText(stop) : ''
  const where = place ? ` bei ${place}` : ''
  if (kind === 'WAITING') {
    const minutes = waitsAtStop(row) ? getDwellMinutes(row, now) : 0
    return { subject, body: `Hallo, der Fahrer wartet${minutes ? ` seit ${waitText(minutes)}` : ''} auf die ${stop?.type === 'LOAD' ? 'Beladung' : 'Entladung'}${where}` }
  }
  const termin = terminOf(row.tour)
  const margin = terminMargin(row)
  const at = termin ? ` ${dayWord(termin.at, now)}um ${terminClock(termin.at)}` : ''
  const eta = row.eta ? `wird voraussichtlich ${dayWord(row.eta, now)}gegen ${clock(row.eta)} da sein` : ''
  const rest = [jam ? 'steht im Stau' : '', eta].filter(Boolean).join(' und ')
  const body = margin !== null && margin < 0
    ? `Hallo, der Fahrer verspätet sich zum Termin${at}${where}`
    : `Hallo, der Fahrer schafft den Termin${at}${where} nur knapp`
  return { subject, body: rest ? `${body}, er ${rest}` : body }
}
