import type { Stop, Tour } from '../types/domain'
import { sharedTerminOf } from './tours'

/**
 * The Auftrag as the driver gets it, pasted into WhatsApp (*bold* is WhatsApp's). Owner, 16.11.2026: as plain as it can be —
 * a sign on every line, the full address in parts (firm, street with number, postcode with town), no links, and a time only
 * when there is a Termin: without one the driver gets the day alone. Never a phone, the driver's name or the system's own
 * notes. A future WhatsApp bot sends the same text.
 */
export function driverMessage(tour: Pick<Tour, 'orderNumber' | 'trailerPlate' | 'tourRemarks' | 'stops' | 'vehicle'>, vehicle?: { vehicleNumber?: string | null; licensePlate?: string | null } | null): string {
  const stops = [...(tour.stops ?? [])].sort((a, b) => a.sequence - b.sequence)
  const open = stops.filter((stop) => !stop.completedAt)
  const truck = vehicle ?? tour.vehicle ?? null
  const plate = truck?.licensePlate || truck?.vehicleNumber
  const head = [`🚛 *Auftrag ${tour.orderNumber}*`]
  if (plate) head.push(`LKW: ${plate}`)
  if (tour.trailerPlate) head.push(`Прицеп: ${tour.trailerPlate}`)
  const blocks = (open.length ? open : stops).map((stop) => stopBlock(stops, stop))
  const remarks = tour.tourRemarks?.trim() ? [`📝 *Важно:* ${tour.tourRemarks.trim()}`] : []
  return [head.join('\n'), ...blocks, ...remarks].join('\n\n')
}

const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']

function stopBlock(stops: Stop[], stop: Stop): string {
  const number = KEYCAPS[stop.sequence - 1] ?? `${stop.sequence}.`
  const lines = [`${number} ${stop.type === 'LOAD' ? '🟢 *ЗАГРУЗКА*' : '🔴 *ВЫГРУЗКА*'}`]
  if (stop.company?.trim()) lines.push(`🏭 ${stop.company.trim()}`)
  const place = addressParts(stop)
  // A point found only as a town would send the driver to the town centre.
  if (stop.geocodePrecision === 'CITY' || stop.geocodePrecision === 'POSTCODE_CITY' || !place.street) {
    lines.push(`🏙️ ${place.town}`, '❗ Точный адрес уточни у диспетчера')
  } else {
    lines.push(`📍 ${place.street}`)
    if (place.town) lines.push(`🏙️ ${place.town}`)
  }
  lines.push(timeLine(stops, stop))
  const references = stop.referenceNumbers ?? parseReferences(stop.referenceNumbersJson)
  if (references?.length) lines.push(`🔖 Ref: ${references.join(', ')}`)
  if (stop.loadingMeters) lines.push(`📏 ${String(stop.loadingMeters).replace('.', ',')} LDM`)
  if (stop.instructions?.trim()) lines.push(`💬 ${stop.instructions.trim()}`)
  return lines.join('\n')
}

/** «Sommerfeld 22-28, 45481 Mülheim an der Ruhr» → street with number, and postcode with town. */
export function addressParts(stop: Pick<Stop, 'address' | 'city'>): { street: string; town: string } {
  const address = stop.address.trim().replace(/,\s*(deutschland|germany|de)$/i, '')
  const split = address.match(/^(.*\S),\s*(\d{5}\s+\S.*)$/)
  if (split) return { street: split[1], town: split[2] }
  const city = stop.city?.trim() ?? ''
  const townName = city.replace(/^\d{5}\s+/, '')
  if (!townName) return { street: '', town: address }
  const withoutTown = address.replace(new RegExp(`,?\\s*(\\d{5}\\s+)?${escapeRegExp(townName)}$`, 'i'), '').trim()
  return { street: withoutTown, town: city }
}

function timeLine(stops: Stop[], stop: Stop): string {
  const shared = sharedTerminOf(stops, stop)
  if (shared) return `⏰ Termin тот же, что у точки ${shared.lead.sequence}`
  if (stop.appointmentAt) return `⏰ Termin: ${day(stop.appointmentAt)} в ${clock(stop.appointmentAt)}`
  if (stop.appointmentWindowStartAt && stop.appointmentWindowEndAt) {
    return `⏰ Termin: ${day(stop.appointmentWindowStartAt)} с ${clock(stop.appointmentWindowStartAt)} до ${clock(stop.appointmentWindowEndAt)}`
  }
  // Without a Termin the planned hour is ours, not the plant's: the driver gets the day only.
  return stop.plannedAt ? `📅 ${day(stop.plannedAt)} (без Termin)` : '📅 без Termin'
}

const DAY = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' })
const CLOCK = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = (value: string) => DAY.format(new Date(value)).replace(/\.$/, '')
const clock = (value: string) => CLOCK.format(new Date(value))

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseReferences(json?: string | null): string[] | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null
  } catch {
    return null
  }
}
