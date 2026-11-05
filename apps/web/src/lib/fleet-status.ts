import { formatDelay, formatDurationMinutes, formatDateTime, formatTime, shortAddress, statusLabel } from './format'
import { currentStopOf, terminOf } from './tours'
import type { DashboardVehicle } from '../types/domain'

export type AttentionTone = 'dwell' | 'critical' | 'action' | 'watch' | 'moving' | 'ok' | 'idle'
export type StatusTone = 'ok' | 'stop' | 'late' | 'plan' | 'idle'
export type FleetFilter = 'ALL' | 'DECIDE' | 'MOVING' | 'AT_STOP' | 'TERMIN' | 'NO_TERMIN' | 'IDLE'
export type FleetSort = 'URGENCY' | 'NUMBER' | 'TERMIN'

export function getDwellMinutes(row: DashboardVehicle, now = Date.now()) {
  if (typeof row.dwellMinutes === 'number') return row.dwellMinutes > 0 ? Math.max(1, Math.ceil(row.dwellMinutes)) : 0
  const stop = row.currentStop ?? row.tour?.stops?.find((item) => item.arrivedAt && !item.completedAt)
  return stop?.arrivedAt ? Math.max(1, Math.ceil((now - new Date(stop.arrivedAt).getTime()) / 60_000)) : 0
}

/** How urgent the truck is for the dispatcher; the rank orders the list. */
export function getAttention(row: DashboardVehicle, now = Date.now()): { rank: number; tone: AttentionTone; label: string; reason: string } {
  const breakdown = row.issues?.find(issue => issue.kind === 'BREAKDOWN')
  if (breakdown) return { rank: -1, tone: 'critical', label: 'Ремонт', reason: `${breakdown.description} · ${breakdown.expectedResolvedAt ? `ETA условная, ремонт до ${formatDateTime(breakdown.expectedResolvedAt)}` : 'Срок ремонта и ETA неизвестны'}` }
  // Daily rest at the stop is known and explained: no «long stop» alarm and no BELADEN reminder while the driver sleeps.
  if (row.restAtStop) return { rank: 3, tone: 'watch', label: 'Суточный отдых', reason: restNote(row, now) ?? 'Суточный отдых на точке' }
  const dwellMinutes = getDwellMinutes(row, now)
  const dwellSeverity = row.dwellSeverity ?? (dwellMinutes > 120 ? 'CRITICAL' : dwellMinutes > 60 ? 'WARNING' : 'NONE')
  if (dwellSeverity === 'CRITICAL') return { rank: 0, tone: 'dwell', label: 'Долгая стоянка', reason: `На точке ${formatDurationMinutes(dwellMinutes)}` }
  if (row.risk === 'RED' || (row.delayMinutes ?? 0) > 0) return { rank: 1, tone: 'critical', label: 'Критично', reason: `Опоздание ${formatDelay(row.delayMinutes)}` }
  if (dwellSeverity === 'WARNING') return { rank: 2, tone: 'action', label: 'Стоянка', reason: `На точке ${formatDurationMinutes(dwellMinutes)}` }
  // Only a recorded arrival (GPS, or the dispatcher for a truck without Webfleet) asks for BELADEN/ENTLADEN; the timer never does.
  const waitingForEvent = Boolean(row.currentAction && !row.currentAction.manual && (row.currentAction.type === 'MARK_LOADED' || row.currentAction.type === 'MARK_UNLOADED'))
  if (row.risk === 'ORANGE' || waitingForEvent) return { rank: 2, tone: 'action', label: 'Нужно действие', reason: waitingForEvent ? `Ожидается отметка ${row.currentAction?.type === 'MARK_LOADED' ? 'загрузки' : 'выгрузки'} на точке` : 'Высокий риск нарушения срока' }
  if (terminToday(row, now)) return { rank: 3, tone: 'watch', label: 'Termin сегодня', reason: terminOf(row.tour)?.label ?? 'Termin сегодня' }
  if (row.risk === 'YELLOW') return { rank: 4, tone: 'watch', label: 'Контроль', reason: 'Небольшой запас до термина' }
  if (row.statusText === 'MOVING') return { rank: 5, tone: 'moving', label: 'В пути', reason: 'Движется по расчётному маршруту' }
  if (row.risk === 'GREEN') return { rank: 6, tone: 'ok', label: 'По плану', reason: 'Отклонений по текущему расчёту нет' }
  return { rank: 7, tone: 'idle', label: 'Без контроля', reason: row.tour ? statusLabel(row.statusText) : 'Нет активного тура' }
}

function berlinDay(value: number) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
}

/** The next stop's Termin falls on today's date in Berlin. */
export function terminToday(row: DashboardVehicle, now = Date.now()) {
  const termin = terminOf(row.tour)
  return Boolean(termin && berlinDay(new Date(termin.at).getTime()) === berlinDay(now))
}

/** At the stop only when an arrival is recorded, the truck is stopped by hand, or (without Webfleet) the dispatcher can confirm it. */
function atStop(row: DashboardVehicle, now: number) {
  if (row.statusText === 'MANUAL_STOP' || getDwellMinutes(row, now) > 0) return true
  return row.statusText === 'ARRIVED' && Boolean(row.currentAction?.withoutGpsArrival)
}

/** The word and colour of the second line of a list row, the map pill and the bottom panel. */
export function vehicleStatus(row: DashboardVehicle, now = Date.now()): { label: string; tone: StatusTone } {
  if (row.issues?.some((issue) => issue.kind === 'BREAKDOWN')) return { label: 'Ремонт', tone: 'late' }
  if (row.risk === 'RED' || (row.delayMinutes ?? 0) > 0) return { label: 'Опоздание', tone: 'late' }
  const stop = row.currentStop ?? (row.tour ? currentStopOf(row.tour) : null)
  if (atStop(row, now)) {
    if (row.statusText === 'MANUAL_STOP') return { label: 'Стоянка', tone: 'stop' }
    if (row.restAtStop) return { label: 'Суточный отдых', tone: 'stop' }
    // Resting with driving time left is a break: the truck goes on after it, not tomorrow.
    if (row.stopActivity?.kind === 'BREAK') return { label: 'Пауза', tone: 'stop' }
    return { label: stop?.type === 'UNLOAD' ? 'Выгрузка' : stop?.type === 'LOAD' ? 'Загрузка' : 'На точке', tone: 'stop' }
  }
  if (row.statusText === 'WAITING') return { label: 'Пауза', tone: 'ok' }
  if (row.statusText === 'MOVING' || row.predictedArrival || row.statusText === 'ARRIVED') return { label: 'В пути', tone: 'ok' }
  if (row.tour && !['IDLE', 'NO_ACTIVE_ROUTE'].includes(row.statusText)) return { label: 'Запланирован', tone: 'plan' }
  return { label: 'Без тура', tone: 'idle' }
}

/** «Суточный отдых до 23:46 · потом загрузка»: when the driver may work again and what goes on then. */
export function restNote(row: DashboardVehicle, now = Date.now()) {
  const rest = row.restAtStop
  if (!rest) return null
  const work = rest.stopType === 'LOAD' ? 'загрузка' : 'выгрузка'
  const until = rest.until ? (berlinDay(new Date(rest.until).getTime()) === berlinDay(now) ? formatTime(rest.until) : formatDateTime(rest.until)) : null
  return `Суточный отдых${until ? ` до ${until}` : ''} · потом ${work}`
}

/**
 * What the driver does at the stop, in one line, from the tachograph:
 * «Суточный отдых до 23:46 · потом загрузка», «Пауза с 14:10 · вождения ещё 2 ч 30 мин», «Ждёт с 13:50», «Идёт работа с 13:20».
 */
export function activityNote(row: DashboardVehicle, now = Date.now()) {
  if (row.restAtStop) return restNote(row, now)
  const activity = row.stopActivity
  if (!activity || activity.kind === 'DAILY_REST') return null
  const at = (iso: string) => berlinDay(new Date(iso).getTime()) === berlinDay(now) ? formatTime(iso) : formatDateTime(iso)
  const since = activity.since ? ` с ${at(activity.since)}` : ''
  if (activity.kind === 'WAITING') return `Ждёт${since} · готовность`
  if (activity.kind === 'WORKING') return `Идёт работа${since}`
  const left = activity.drivingLeftMs !== null && activity.drivingLeftMs > 0 ? ` · вождения ещё ${formatDurationMinutes(Math.floor(activity.drivingLeftMs / 60_000))}` : ''
  const shift = activity.shiftEndAt ? ` · смена до ${at(activity.shiftEndAt)}` : ''
  return `Пауза${since}${left}${shift}`
}

/** Where the truck is or goes: "A38 → Zwickau", "Magdeburg", "Bovenden → Chemnitz". */
export function vehiclePlace(row: DashboardVehicle) {
  const target = row.to ? shortAddress(row.to) : null
  const here = row.telemetry?.source === 'WEBFLEET' && row.telemetry.address ? row.telemetry.address.split(',')[0]?.trim() : null
  if (vehicleStatus(row).tone === 'stop') return row.currentStop ? shortAddress(row.currentStop) : here ?? target ?? ''
  const from = here || (row.from ? shortAddress(row.from) : null)
  if (from && target && from !== target) return `${from} → ${target}`
  return from ?? target ?? ''
}

/** Minutes between ETA and Termin: positive is a reserve, negative is a delay. Null without both. */
export function terminMargin(row: DashboardVehicle) {
  const termin = terminOf(row.tour)
  if ((row.delayMinutes ?? 0) > 0) return -Math.round(row.delayMinutes ?? 0)
  if (!termin || !row.eta) return null
  return Math.round((new Date(termin.at).getTime() - new Date(row.eta).getTime()) / 60_000)
}

/** "GPS 1 мин" fresh, "GPS 12 мин" stale, "расчёт" without Webfleet. */
export function positionSource(row: DashboardVehicle, now = Date.now()): { kind: 'live' | 'stale' | 'calculated'; short: string; long: string } {
  const telemetry = row.telemetry
  if (telemetry?.source !== 'WEBFLEET') return { kind: 'calculated', short: 'расчёт', long: 'Расчётная позиция' }
  const seconds = typeof telemetry.ageSeconds === 'number' ? telemetry.ageSeconds
    : telemetry.checkedAt ? Math.max(0, (now - new Date(telemetry.checkedAt).getTime()) / 1000) : null
  const age = seconds === null ? '' : ` ${ageText(seconds)}`
  if (telemetry.stale) return { kind: 'stale', short: `GPS${age}`, long: `GPS Webfleet устарел${age ? ` ·${age}` : ''}` }
  return { kind: 'live', short: `GPS${age}`, long: `GPS Webfleet${age ? ` ·${age}` : ''}` }
}

function ageText(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60))
  return minutes < 60 ? `${minutes} мин` : formatDurationMinutes(minutes)
}

/** «Решить»: an open question from Webfleet or Termin, an alarm or a confirmation that waits for the dispatcher. */
export function needsDecision(row: DashboardVehicle, notified: ReadonlySet<string>, now = Date.now()) {
  if (notified.has(row.vehicle.id)) return true
  return getAttention(row, now).rank <= 2
}

/** The next stop belongs to a customer who always sends a Termin, and it has not come yet. */
export function terminNeeded(row: DashboardVehicle) {
  const stop = row.tour ? currentStopOf(row.tour) : null
  return Boolean(stop?.terminRequired && !stop.appointmentAt && !stop.appointmentWindowStartAt)
}

export function matchesFleetFilter(row: DashboardVehicle, filter: FleetFilter, notified: ReadonlySet<string> = new Set(), now = Date.now()) {
  if (filter === 'ALL') return true
  if (filter === 'DECIDE') return needsDecision(row, notified, now)
  if (filter === 'MOVING') return row.statusText === 'MOVING'
  if (filter === 'TERMIN') return Boolean(terminOf(row.tour))
  if (filter === 'NO_TERMIN') return terminNeeded(row)
  if (filter === 'AT_STOP') return atStop(row, now)
  return !row.tour || ['IDLE', 'NO_ACTIVE_ROUTE'].includes(row.statusText)
}

export function compareVehicles(a: DashboardVehicle, b: DashboardVehicle, pinned: string[], sort: FleetSort = 'URGENCY', now = Date.now()) {
  // Pinned trucks stay on top whatever their state; inside each group the chosen order applies.
  const pinDifference = Number(pinned.includes(b.vehicle.id)) - Number(pinned.includes(a.vehicle.id))
  if (pinDifference) return pinDifference
  const byNumber = a.vehicle.vehicleNumber.localeCompare(b.vehicle.vehicleNumber, 'ru', { numeric: true })
  if (sort === 'NUMBER') return byNumber
  if (sort === 'TERMIN') {
    const at = (row: DashboardVehicle) => { const termin = terminOf(row.tour); return termin ? new Date(termin.at).getTime() : Number.POSITIVE_INFINITY }
    return (at(a) - at(b)) || byNumber
  }
  const rankDifference = getAttention(a, now).rank - getAttention(b, now).rank
  if (rankDifference) return rankDifference
  const delayDifference = (b.delayMinutes ?? 0) - (a.delayMinutes ?? 0)
  return delayDifference || byNumber
}
