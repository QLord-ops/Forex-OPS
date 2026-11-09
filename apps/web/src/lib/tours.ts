import type { Stop, Tour } from '../types/domain'

/** A tour can be removed until the first arrival or BELADEN/ENTLADEN; the server checks the same rule. */
export function tourCancellable(tour: Pick<Tour, 'status' | 'stops' | 'events'>) {
  if (tour.status !== 'QUEUED' && tour.status !== 'ACTIVE') return false
  if ((tour.events ?? []).length > 0) return false
  return !(tour.stops ?? []).some((stop) => stop.arrivedAt || stop.completedAt)
}

/** Tours waiting after the current one, in queue order. */
export function followingTours(tours: Tour[], currentId: string | null | undefined) {
  return tours.filter((tour) => tour.status === 'QUEUED' && tour.id !== currentId)
}

export function sortedStops(tour: Pick<Tour, 'stops'>): Stop[] {
  return (tour.stops ?? []).slice().sort((a, b) => a.sequence - b.sequence)
}

/** The stop the truck is heading to or standing at: the first one not yet done. */
export function currentStopOf(tour: Pick<Tour, 'stops'>): Stop | null {
  return sortedStops(tour).find((stop) => !stop.completedAt) ?? null
}

/**
 * The slot attached to the stop the truck is heading to or standing at, as a short label.
 * Null when that stop has no exact time and no window.
 */
export function terminOf(tour: Pick<Tour, 'stops'> | null | undefined): { label: string; at: string } | null {
  const stop = tour ? currentStopOf(tour) : null
  if (!stop) return null
  if (stop.appointmentAt) return { label: `Termin ${clock(stop.appointmentAt, true)}`, at: stop.appointmentAt }
  if (stop.appointmentWindowStartAt && stop.appointmentWindowEndAt) {
    return { label: `Termin ${clock(stop.appointmentWindowStartAt, true)}–${clock(stop.appointmentWindowEndAt, false)}`, at: stop.appointmentWindowStartAt }
  }
  return null
}

/** "04.11 08:00–10:00" for a slot or a window, empty when there is no time. */
export function terminText(slot: { appointmentAt?: string | null; windowStartAt?: string | null; windowEndAt?: string | null }) {
  if (slot.appointmentAt) return clock(slot.appointmentAt, true)
  if (slot.windowStartAt && slot.windowEndAt) return `${clock(slot.windowStartAt, true)}–${clock(slot.windowEndAt, false)}`
  return ''
}

/**
 * Unloading and loading at one plant go under one Termin, kept on the first of the two stops.
 * For the later stop: the stop that keeps the Termin and a label that names it; null for a stop of its own.
 */
export function sharedTerminOf(stops: Stop[], stop: Stop): { lead: Stop; label: string } | null {
  const lead = stop.terminSharedWithStopId ? stops.find((item) => item.id === stop.terminSharedWithStopId) : null
  if (!lead) return null
  const time = terminText({ appointmentAt: lead.appointmentAt, windowStartAt: lead.appointmentWindowStartAt, windowEndAt: lead.appointmentWindowEndAt })
  return { lead, label: `общий Termin с точкой ${lead.sequence}${time ? ` · ${time}` : ''}` }
}

/**
 * The same for an editor, where the stops are drafts in list order: the index of the draft whose Termin covers
 * the one at `index`, or -1 once a time of its own is typed, the pair is pulled apart or one of the two addresses changed.
 */
export function sharedTerminLeadIndex(
  stops: Array<{ id?: string; terminSharedWithStopId?: string | null; appointmentAt?: string | null; moved?: boolean }>,
  index: number
): number {
  const stop = stops[index]
  if (!stop?.terminSharedWithStopId || stop.appointmentAt || stop.moved) return -1
  const lead = stops.findIndex((item) => item.id === stop.terminSharedWithStopId)
  if (lead < 0 || lead >= index || stops[lead].moved) return -1
  return stops.slice(lead + 1, index).every((item) => item.terminSharedWithStopId === stop.terminSharedWithStopId && !item.moved) ? lead : -1
}

/** «Termin общий для точек 2 и 3 (Salzgitter) — сохранён на точке 2.»; empty when the Termin covers one stop. */
export function sharedTerminNote(place: { sequences: number[]; city: string | null } | null | undefined, saved: boolean): string {
  if (!place || place.sequences.length < 2) return ''
  const numbers = `${place.sequences.slice(0, -1).join(', ')} и ${place.sequences[place.sequences.length - 1]}`
  return `Termin общий для точек ${numbers}${place.city ? ` (${place.city})` : ''} — ${saved ? 'сохранён' : 'сохранится'} на точке ${place.sequences[0]}.`
}

function clock(value: string, withDate: boolean) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hourCycle: 'h23', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(value)).map((part) => [part.type, part.value]))
  return `${withDate ? `${parts.day}.${parts.month} ` : ''}${parts.hour}:${parts.minute}`
}
