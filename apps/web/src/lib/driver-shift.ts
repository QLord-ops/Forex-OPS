export type DriverShift = { id: string; startsAt: string; endsAt: string; firstUsedAt: string | null; lastUsedAt: string | null; locked: boolean }

/** The shift from the answer, or none: an answer of another shape (an old API, a proxy page) never breaks the truck card. */
export function shiftOf(data: unknown): DriverShift | null {
  const shift = data && typeof data === 'object' && !Array.isArray(data) ? (data as { shift?: unknown }).shift : null
  return shift && typeof shift === 'object' && typeof (shift as DriverShift).endsAt === 'string' && Number.isFinite(Date.parse((shift as DriverShift).endsAt)) ? shift as DriverShift : null
}

/** How long a new code works; 15 h is one working day with the break, a week covers a long tour away from the yard. */
export const SHIFT_LENGTHS = [
  { hours: 15, label: '15 ч — смена' },
  { hours: 24, label: '24 ч' },
  { hours: 72, label: '3 дня' },
  { hours: 168, label: '7 дней — рейс' }
] as const

const berlin = (value: string, withDay: boolean) => new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', ...(withDay ? { day: '2-digit', month: '2-digit' } : {})
}).format(new Date(value))

const sameBerlinDay = (a: string, b: Date) => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
  return day.format(new Date(a)) === day.format(b)
}

/** «до 21:00» today, «до 22.11, 21:00» on another day. */
export function untilText(endsAt: string, now = new Date()) {
  return `до ${berlin(endsAt, !sameBerlinDay(endsAt, now))}`
}

export type ShiftSummary = { tone: 'none' | 'waiting' | 'active' | 'locked'; label: string; detail: string }

export function shiftSummary(shift: DriverShift | null, now = new Date()): ShiftSummary {
  if (!shift) return { tone: 'none', label: 'Смены нет', detail: 'Выдайте код: водитель входит в приложение номером машины и этим кодом.' }
  const until = untilText(shift.endsAt, now)
  if (shift.locked) return { tone: 'locked', label: 'Код заблокирован', detail: `5 неверных попыток подряд. Выдайте новый код (${until}).` }
  if (!shift.firstUsedAt) return { tone: 'waiting', label: `Код выдан, ${until}`, detail: 'Водитель ещё не входил.' }
  const last = shift.lastUsedAt ?? shift.firstUsedAt
  return { tone: 'active', label: `В приложении, ${until}`, detail: `Вход с телефона: ${berlin(last, !sameBerlinDay(last, now))}.` }
}

/** «482 915»: easier to read out over the phone. */
export const spacedCode = (code: string) => code.replace(/^(\d{3})(\d{3})$/, '$1 $2')
