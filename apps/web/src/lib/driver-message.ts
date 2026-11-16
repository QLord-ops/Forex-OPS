import type { Stop, Tour } from '../types/domain'
import { googleMapsUrl } from './stop-zone'
import { sharedTerminOf, terminText } from './tours'

/**
 * The Auftrag as the driver gets it (owner, 16.11.2026): in Russian, ready to paste into WhatsApp (*bold* is WhatsApp's).
 * Only what the driver needs on the road — where, when, what to name at the gate, a map link. Never a phone number, the
 * driver's name or the system's own notes. A future WhatsApp bot sends the same text.
 */
export function driverMessage(tour: Pick<Tour, 'orderNumber' | 'trailerPlate' | 'tourRemarks' | 'stops' | 'vehicle'>, vehicle?: { vehicleNumber?: string | null; licensePlate?: string | null } | null): string {
  const stops = [...(tour.stops ?? [])].sort((a, b) => a.sequence - b.sequence)
  const open = stops.filter((stop) => !stop.completedAt)
  const truck = vehicle ?? tour.vehicle ?? null
  const plate = truck?.licensePlate || truck?.vehicleNumber
  const head = [`*Auftrag ${tour.orderNumber}*`, [plate ? `LKW ${plate}` : '', tour.trailerPlate ? `прицеп ${tour.trailerPlate}` : ''].filter(Boolean).join(' · ')].filter(Boolean)
  const blocks = (open.length ? open : stops).map((stop) => stopBlock(stops, stop))
  const remarks = tour.tourRemarks?.trim() ? [`Примечание к туру: ${tour.tourRemarks.trim()}`] : []
  return [head.join('\n'), ...blocks, ...remarks].join('\n\n')
}

function stopBlock(stops: Stop[], stop: Stop): string {
  const lines = [`*${stop.sequence}. ${stop.type === 'LOAD' ? 'Загрузка' : 'Выгрузка'}*${stop.company?.trim() ? ` — ${stop.company.trim()}` : ''}`]
  lines.push(stop.address.trim())
  const time = timeLine(stops, stop)
  if (time) lines.push(time)
  const references = stop.referenceNumbers ?? parseReferences(stop.referenceNumbersJson)
  const cargo = [references?.length ? `Ref: ${references.join(', ')}` : '', stop.loadingMeters ? `${String(stop.loadingMeters).replace('.', ',')} LDM` : ''].filter(Boolean).join(' · ')
  if (cargo) lines.push(cargo)
  if (stop.instructions?.trim()) lines.push(`Примечание: ${stop.instructions.trim()}`)
  // A point found only as a town would send the driver to the town centre.
  lines.push(stop.geocodePrecision === 'CITY' || stop.geocodePrecision === 'POSTCODE_CITY' ? 'Точный адрес уточнить у диспетчера' : googleMapsUrl(stop.latitude, stop.longitude))
  return lines.join('\n')
}

function timeLine(stops: Stop[], stop: Stop): string {
  const shared = sharedTerminOf(stops, stop)
  if (shared) return `Termin: вместе с точкой ${shared.lead.sequence}`
  const termin = terminText({ appointmentAt: stop.appointmentAt, windowStartAt: stop.appointmentWindowStartAt, windowEndAt: stop.appointmentWindowEndAt })
  if (termin) return `Termin: ${termin}`
  const planned = stop.plannedAt ? terminText({ appointmentAt: stop.plannedAt }) : ''
  return planned ? `План: ${planned}, без Termin` : ''
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
