/** The dispatcher's working day, kept in this browser like the theme and the sound. Times are Germany time. */
export interface WorkHours {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[]
  start: string
  end: string
}

export const DEFAULT_WORK_HOURS: WorkHours = { days: [1, 2, 3, 4, 5, 6], start: '06:00', end: '18:00' }
export const WORK_HOURS_EVENT = 'ops:work-hours'
const KEY = 'ops-work-hours'
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

export function validWorkHours(value: unknown): value is WorkHours {
  if (!value || typeof value !== 'object') return false
  const hours = value as Partial<WorkHours>
  return Array.isArray(hours.days) && hours.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    && typeof hours.start === 'string' && TIME.test(hours.start) && typeof hours.end === 'string' && TIME.test(hours.end)
    && minutesOf(hours.start) < minutesOf(hours.end)
}

export function readWorkHours(): WorkHours {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? 'null')
    return validWorkHours(value) ? value : DEFAULT_WORK_HOURS
  } catch { return DEFAULT_WORK_HOURS }
}

export function saveWorkHours(hours: WorkHours) {
  try { window.localStorage.setItem(KEY, JSON.stringify(hours)) } catch { /* per-viewer convenience only */ }
  window.dispatchEvent(new CustomEvent(WORK_HOURS_EVENT, { detail: hours }))
}

function minutesOf(time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

const PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function berlin(now: Date) {
  const parts = Object.fromEntries(PARTS.formatToParts(now).map((part) => [part.type, part.value]))
  return { day: WEEKDAYS.indexOf(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}

export function isWorkTime(now: Date, hours: WorkHours = DEFAULT_WORK_HOURS) {
  const { day, minutes } = berlin(now)
  return hours.days.includes(day) && minutes >= minutesOf(hours.start) && minutes < minutesOf(hours.end)
}

/** When the last working day ended before `now`: everything after it came while the dispatcher was away. */
export function lastShiftEnd(now: Date, hours: WorkHours = DEFAULT_WORK_HOURS): Date | null {
  if (!hours.days.length) return null
  const end = minutesOf(hours.end)
  const { day, minutes } = berlin(now)
  const startOfMinute = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
  for (let back = 0; back <= 7; back += 1) {
    const weekday = (day - back + 7) % 7
    if (!hours.days.includes(weekday)) continue
    if (back === 0 && minutes < end) continue
    // Walk back in whole minutes from now; one hour of DST shift at most moves the mark by an hour, which is fine here.
    return new Date(startOfMinute.getTime() - ((back * 24 * 60) + minutes - end) * 60_000)
  }
  return null
}

export function workHoursText(hours: WorkHours) {
  const names = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
  const days = [1, 2, 3, 4, 5, 6, 0].filter((day) => hours.days.includes(day)).map((day) => names[day]).join(', ')
  return `${days || 'нет дней'} · ${hours.start}–${hours.end}`
}
