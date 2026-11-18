import { terminMargin, vehicleStatus } from './fleet-status'
import { formatTime } from './format'
import { currentStopOf, terminOf } from './tours'
import type { DashboardVehicle } from '../types/domain'

/** Under this reserve the dispatcher is offered to warn the customer (owner, 18.11: «при опоздании»). */
export const NOTICE_RESERVE_MINUTES = 15

/** A truck on the way to a Termin it will miss or barely make, on a tour of a customer. */
export function noticeDue(row: DashboardVehicle): boolean {
  if (!row.tour || !row.customer || !row.eta || vehicleStatus(row).tone === 'stop') return false
  const stop = currentStopOf(row.tour)
  if (!stop || stop.completedAt || stop.arrivedAt || !terminOf(row.tour)) return false
  const margin = terminMargin(row)
  return margin !== null && margin < NOTICE_RESERVE_MINUTES
}

/** «Заказчик уведомлён 13:45, Anna» when the last letter was about the current stop. */
export function noticeLine(row: DashboardVehicle): string | null {
  const notice = row.customerNotice
  const stop = row.tour ? currentStopOf(row.tour) : null
  if (!notice || !stop || notice.stopId !== stop.id) return null
  return `Заказчик уведомлён ${formatTime(notice.at)}, ${notice.by}${notice.channel === 'COPY' ? ' (текст скопирован)' : ''}`
}

const berlin = (iso: string) => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

export function draftNotice(row: DashboardVehicle, reason: string, signature: string) {
  const stop = row.tour ? currentStopOf(row.tour) : null
  const termin = terminOf(row.tour)
  const margin = terminMargin(row)
  const plate = row.vehicle.licensePlate && row.vehicle.licensePlate !== row.vehicle.vehicleNumber ? ` (${row.vehicle.licensePlate})` : ''
  const action = stop?.type === 'LOAD' ? 'Beladung' : 'Entladung'
  const place = [stop?.company, stop?.address && stop.address !== stop.company ? stop.address : null].filter(Boolean).join(', ') || stop?.city || ''
  const late = margin !== null && margin < 0
  const subject = `${late ? 'Verspätung' : 'Ankunftszeit'} LKW ${row.vehicle.vehicleNumber}${row.tour ? ` · Auftrag ${row.tour.orderNumber}` : ''}${stop?.city ? ` · ${stop.city}` : ''}`
  const lines = [
    'Guten Tag,',
    '',
    late
      ? `unser LKW ${row.vehicle.vehicleNumber}${plate} zum Auftrag ${row.tour?.orderNumber ?? ''} kommt später als geplant.`
      : `unser LKW ${row.vehicle.vehicleNumber}${plate} zum Auftrag ${row.tour?.orderNumber ?? ''} wird knapp zum Termin ankommen.`,
    '',
    `${action}: ${place}`,
    termin ? `Termin: ${berlin(termin.at)}` : null,
    row.eta ? `Voraussichtliche Ankunft: ${berlin(row.eta)}${late ? ` (ca. ${Math.abs(margin!)} Min. später)` : ''}` : null,
    reason ? `Grund: ${reason}` : null,
    '',
    'Wir melden uns, falls sich die Ankunftszeit weiter ändert.',
    '',
    'Mit freundlichen Grüßen',
    signature,
    'Forex GmbH · Disposition'
  ].filter((line): line is string => line !== null)
  return { subject, body: lines.join('\n') }
}
