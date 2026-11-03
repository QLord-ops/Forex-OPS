/**
 * Tachograph durations arrive in milliseconds; a negative value means the limit is already exceeded.
 * Always hours, never days: driving limits are counted in hours (56 h a week).
 */
export function formatDurationMs(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–'
  const minutes = Math.floor(Math.abs(value) / 60_000)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const text = hours && rest ? `${hours} ч ${rest} мин` : hours ? `${hours} ч` : `${rest} мин`
  return value < 0 ? `превышено на ${text}` : text
}

const COURSE_NAMES = ['на север', 'на северо-восток', 'на восток', 'на юго-восток', 'на юг', 'на юго-запад', 'на запад', 'на северо-запад']

export function courseText(degrees?: number | null): string {
  if (degrees === null || degrees === undefined || !Number.isFinite(degrees)) return ''
  return COURSE_NAMES[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]
}

/** WEBFLEET.connect driver work states (driver_currentworkstate). Unknown codes are not guessed. */
const WORK_STATES: Record<number, { label: string; tone: 'driving' | 'work' | 'rest' | 'unknown' }> = {
  1: { label: 'Свободное время', tone: 'rest' },
  2: { label: 'Пауза', tone: 'rest' },
  3: { label: 'Готовность', tone: 'work' },
  4: { label: 'Работа', tone: 'work' },
  5: { label: 'За рулём', tone: 'driving' },
  6: { label: 'Другая работа', tone: 'work' }
}

export function workState(code?: number | null) {
  return (code !== null && code !== undefined && WORK_STATES[code]) || { label: 'Состояние неизвестно', tone: 'unknown' as const }
}

export function formatWholeKm(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–'
  return `${Math.round(value).toLocaleString('ru-RU')} км`
}

export function formatFuel(percent?: number | null, liters?: number | null): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return '–'
  return liters ? `${Math.round(percent)} % · ~${liters.toLocaleString('ru-RU')} л` : `${Math.round(percent)} %`
}

const BERLIN_DAY = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
const BERLIN_TIME = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })
const BERLIN_DATE = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' })

/** Clock time in Berlin, with the date when it is not today: "11:06" or "08.11, 06:08". */
export function berlinClock(value?: string | null, now = new Date()): string {
  if (!value) return '–'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '–'
  const time = BERLIN_TIME.format(date)
  return BERLIN_DAY.format(date) === BERLIN_DAY.format(now) ? time : `${BERLIN_DATE.format(date)}, ${time}`
}

/** "1 ч 6 мин" between two moments; used for "since" and parking gaps. */
export function durationBetween(from?: string | null, to?: string | Date | null): string {
  if (!from || !to) return '–'
  const ms = (to instanceof Date ? to.getTime() : Date.parse(to)) - Date.parse(from)
  return Number.isFinite(ms) && ms >= 0 ? formatDurationMs(ms) : '–'
}

/** Trips newest first, with the parking time before each trip (gap to the previous trip's end). */
export function tripsWithParking<T extends { startAt: string; endAt: string | null }>(trips: T[]) {
  const ordered = trips.slice().sort((a, b) => b.startAt.localeCompare(a.startAt))
  return ordered.map((trip, index) => {
    const previous = ordered[index + 1]
    const parkedMs = previous?.endAt ? Date.parse(trip.startAt) - Date.parse(previous.endAt) : null
    return { trip, parkedMs: parkedMs !== null && parkedMs > 0 ? parkedMs : null }
  })
}

/** Share of a limit for progress bars, clamped to 0..1. */
export function share(part?: number | null, whole?: number | null): number {
  if (!part || !whole || whole <= 0) return 0
  return Math.min(1, Math.max(0, part / whole))
}
