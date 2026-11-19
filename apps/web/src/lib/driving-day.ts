import { formatDurationMinutes } from './format'

/**
 * The driver's day at a stop (owner, 19.11): how much driving is left on arrival, and whether the 10th hour was needed
 * to make the Termin. A day is planned on 9 h; null when the hours are unknown.
 */
export function drivingDayText(driveLeftSeconds: number | null | undefined, extendedDay = false): { text: string; extended: boolean } | null {
  if (driveLeftSeconds === null || driveLeftSeconds === undefined) return extendedDay ? { text: '10-й час вождения ради Termin', extended: true } : null
  const minutes = Math.max(0, Math.floor(driveLeftSeconds / 60))
  const left = minutes > 0 ? `останется вождения ${formatDurationMinutes(minutes)}` : 'вождения на сегодня не останется'
  return { text: extendedDay ? `10-й час вождения ради Termin · ${left}` : left, extended: extendedDay }
}
