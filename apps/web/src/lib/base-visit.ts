import type { BaseVisit, DashboardVehicle } from '../types/domain'

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

/** «пт 18:00» in Berlin time: the week is short, the weekday says more than a date. */
export function weekdayClock(iso: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((part) => [part.type, part.value]))
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
  return `${WEEKDAYS[index] ?? ''} ${parts.hour}:${parts.minute}`.trim()
}

export type BaseChip = { label: string; tone: 'ok' | 'late' | 'plain'; title: string }

/** The truck's week at the base as one chip of the list: where it stands with the deadline, in words next to the colour. */
export function baseChip(visit: BaseVisit | null | undefined): BaseChip | null {
  if (!visit) return null
  if (visit.state === 'AT_BASE') return { label: `на базе до ${weekdayClock(visit.freeAt)}`, tone: 'ok',
    title: `На базе с ${weekdayClock(visit.arrivedAt ?? visit.freeAt)}${visit.arrivedSource === 'WEBFLEET_AUTO' ? ' (GPS Webfleet)' : ' (отметил диспетчер)'}. Снова работает с ${weekdayClock(visit.freeAt)}.` }
  if (visit.state === 'OVERDUE') return { label: 'на базу: срок прошёл', tone: 'late', title: `Должна была быть на базе к ${weekdayClock(visit.dueAt)}.` }
  if (visit.state === 'TIGHT') return { label: `на базу до ${weekdayClock(visit.dueAt)} · не успевает`, tone: 'late',
    title: `После последней точки на базе примерно в ${weekdayClock(visit.expectedAt!)} — оценка по расстоянию, не ETA.` }
  return { label: `на базу до ${weekdayClock(visit.dueAt)}`, tone: 'plain',
    title: visit.expectedAt ? `После последней точки на базе примерно в ${weekdayClock(visit.expectedAt)} — оценка по расстоянию, не ETA.` : 'Машина на этой неделе едет на базу.' }
}

/** On this week's list and not yet at the base: the «на базу» figure and filter. */
export function headsToBase(row: DashboardVehicle): boolean {
  return Boolean(row.baseVisit && row.baseVisit.state !== 'AT_BASE')
}
export function onBaseList(row: DashboardVehicle): boolean { return Boolean(row.baseVisit) }

/** Monday of the Berlin week of `now` as «YYYY-MM-DD», and the Monday `weeks` later. */
export function weekKey(now = Date.now(), weeks = 0): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map((part) => [part.type, part.value]))
  const today = Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`)
  const weekday = new Date(today).getUTCDay() || 7
  return new Date(today + (1 - weekday + weeks * 7) * 86_400_000).toISOString().slice(0, 10)
}
/** «16.11–22.11». */
export function weekLabel(key: string): string {
  const start = Date.parse(`${key}T00:00:00.000Z`)
  const short = (time: number) => { const date = new Date(time); return `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}` }
  return `${short(start)}–${short(start + 6 * 86_400_000)}`
}
