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
  if (stop.appointmentAt) return { label: `Термин ${clock(stop.appointmentAt, true)}`, at: stop.appointmentAt }
  if (stop.appointmentWindowStartAt && stop.appointmentWindowEndAt) {
    return { label: `Термин ${clock(stop.appointmentWindowStartAt, true)}–${clock(stop.appointmentWindowEndAt, false)}`, at: stop.appointmentWindowStartAt }
  }
  return null
}

function clock(value: string, withDate: boolean) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hourCycle: 'h23', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(value)).map((part) => [part.type, part.value]))
  return `${withDate ? `${parts.day}.${parts.month} ` : ''}${parts.hour}:${parts.minute}`
}
