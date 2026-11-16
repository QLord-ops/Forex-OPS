import type { Stop, Tour } from '../types/domain'
import { sharedTerminOf } from './tours'

/**
 * The Auftrag as the driver gets it in WhatsApp, laid out like the owner's own messages (16.11.2026): few signs, «Загрузка Nr. 1»,
 * the full address in lines (firm, street with number, postcode with town), the date, a time only with a Termin, and the
 * stop's own Referenz. No links, no notes.
 * Never a phone, the driver's name or the system's own notes. A future WhatsApp bot sends the same text.
 */
export function driverMessage(tour: Pick<Tour, 'orderNumber' | 'stops'>): string {
  const stops = [...(tour.stops ?? [])].sort((a, b) => a.sequence - b.sequence)
  const open = stops.filter((stop) => !stop.completedAt)
  const shown = open.length ? open : stops
  // No notes: the Tourbemerkung and stop notes are written for the dispatcher, not the driver (owner, 16.11).
  return [`📄 Auftrag: ${tour.orderNumber}`, ...shown.map((stop) => stopBlock(stops, stop))].join('\n\n')
}

/** «Загрузка Nr. 2»: counted per kind over the whole tour, so the numbers stay put while stops get done. */
function stopTitle(stops: Stop[], stop: Stop) {
  const number = stops.filter((item) => item.type === stop.type && item.sequence <= stop.sequence).length
  return `${stop.type === 'LOAD' ? 'Загрузка' : 'Выгрузка'} Nr. ${number}`
}

function stopBlock(stops: Stop[], stop: Stop): string {
  const lines = [`${stop.type === 'LOAD' ? '📦' : '📍'} ${stopTitle(stops, stop)}${stop.company?.trim() ? `: ${stop.company.trim()}` : ''}`]
  const place = addressParts(stop)
  // A point found only as a town would send the driver to the town centre.
  if (stop.geocodePrecision === 'CITY' || stop.geocodePrecision === 'POSTCODE_CITY' || !place.street) {
    lines.push(place.town, 'Точный адрес уточни у диспетчера')
  } else {
    lines.push(place.street)
    if (place.town) lines.push(place.town)
  }
  const time = timeLine(stops, stop)
  if (time) lines.push(time)
  // Each stop names its own references: the driver gives them at that gate (owner, 16.11).
  const references = (stop.referenceNumbers ?? parseReferences(stop.referenceNumbersJson) ?? []).map((value) => value.trim()).filter(Boolean)
  if (references.length) lines.push(`📄 Referenz: ${[...new Set(references)].join(', ')}`)
  return lines.join('\n')
}

/**
 * «Sommerfeld 22-28, 45481 Mülheim an der Ruhr» → street with number, and postcode with town. An Auftrag that prints no
 * postcode («Zachower Str. 4, Ketzin OT Tremmen») gets the one of the address the stop was found at.
 */
export function addressParts(stop: Pick<Stop, 'address' | 'city'> & { resolvedAddress?: string | null }): { street: string; town: string } {
  const address = stop.address.trim().replace(/,\s*(deutschland|germany|de)$/i, '')
  const split = address.match(/^(.*\S),\s*(\d{5}\s+\S.*)$/)
  if (split) return { street: split[1], town: split[2] }
  let city = stop.city?.trim() ?? ''
  let street = ''
  const townName = city.replace(/^\d{5}\s+/, '')
  if (townName) street = address.replace(new RegExp(`,?\\s*(\\d{5}\\s+)?${escapeRegExp(townName)}$`, 'i'), '').trim()
  else {
    const lastComma = address.lastIndexOf(',')
    if (lastComma < 0) return { street: '', town: address }
    street = address.slice(0, lastComma).trim()
    city = address.slice(lastComma + 1).trim()
  }
  const postcode = /^\d{5}\s/.test(city) ? '' : stop.resolvedAddress?.match(/\b(\d{5})\b/)?.[1]
  return { street, town: postcode ? `${postcode} ${city}` : city }
}

function timeLine(stops: Stop[], stop: Stop): string {
  const shared = sharedTerminOf(stops, stop)
  if (shared) return `Termin как у ${stopTitle(stops, shared.lead).replace(/^Загрузка/, 'загрузки').replace(/^Выгрузка/, 'выгрузки')}`
  if (stop.appointmentAt) return `${day(stop.appointmentAt)} ${clock(stop.appointmentAt)}`
  if (stop.appointmentWindowStartAt && stop.appointmentWindowEndAt) {
    return `${day(stop.appointmentWindowStartAt)} ${clock(stop.appointmentWindowStartAt)}–${clock(stop.appointmentWindowEndAt)}`
  }
  // Without a Termin the planned hour is ours, not the plant's: the driver gets the day only.
  return stop.plannedAt ? day(stop.plannedAt) : ''
}

const DAY = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' })
const CLOCK = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = (value: string) => DAY.format(new Date(value))
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
