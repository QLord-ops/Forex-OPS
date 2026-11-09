import type { DriveEtaPlan } from '../domain.js';
import { applyStopTime, createUnknownClockState, forecastDrive, type ClockState } from './vehicle-clock.js';
import type { WebfleetDriverActivity, WebfleetDrivingTimes } from './webfleet-live.js';

const MINUTE = 60;
const HOUR = 3600;
/** Regulation (EC) 561/2006 as the tachograph applies it after a simulated break or rest. */
const CONTINUOUS_DRIVE_SECONDS = 4.5 * HOUR;
const BREAK_SECONDS = 45 * MINUTE;
const DAILY_DRIVE_SECONDS = 9 * HOUR;
const DUTY_WINDOW_SECONDS = 13 * HOUR;
export const DAILY_REST_SECONDS = 11 * HOUR;
export const REDUCED_REST_SECONDS = 9 * HOUR;
/** A pause shorter than this is not part of a break on the tachograph. */
const MIN_BREAK_PART_SECONDS = 15 * MINUTE;
/** Tachograph figures older than this no longer say where the driver's day stands. */
const TIMES_MAX_AGE_MS = 60 * 60_000;
export const TERMIN_BUFFER_MINUTES = 30;
const WORK_STATE_DRIVING = 5;
const WORK_STATE_BREAK = 2;

export type PlannerStopType = 'LOAD' | 'UNLOAD' | 'VISIT';
export type PlannerStop = {
  stopId: string | null; tourId: string | null; label: string; type: PlannerStopType;
  /** Driving seconds from the previous point; null when no route is known. */
  driveSeconds: number | null;
  serviceMinMinutes: number; serviceMaxMinutes: number;
  appointmentAt: string | null; appointmentWindowStartAt: string | null; appointmentWindowEndAt: string | null;
  terminRequired: boolean; arrivedAt: string | null;
};
export type DriverBudget = {
  referenceTime: string; workState: number | null; activitySince: string | null;
  continuousDriveLeftSeconds: number; breakSeconds: number;
  dailyDriveLeftSeconds: number; drivenTodaySeconds: number; maxDailyDriveSeconds: number;
  shiftEndAt: string | null; restLatestAt: string | null; restSeconds: number;
  weeklyDriveLeftSeconds: number | null; extendedShiftsLeft: number | null; reducedRestsLeft: number | null;
  earliestNextShiftAt: string | null;
  /** Remaining part of a break the driver is sitting out right now. */
  breakRemainingSeconds: number;
};
export type TerminSegmentType = 'DRIVE' | 'BREAK' | 'DAILY_REST' | 'SERVICE' | 'WAIT';
export type TerminSegment = { type: TerminSegmentType; startAt: string; endAt: string; startLocal: string; endLocal: string; durationSeconds: number; label: string; stopId: string | null };
export type TerminVerdict = 'OK' | 'RISK' | 'LATE';
export type TerminStopResult = {
  stopId: string | null; label: string; type: PlannerStopType; driveSeconds: number | null;
  earliestArrival: string | null; latestArrival: string | null; earliestArrivalLocal: string | null; latestArrivalLocal: string | null;
  earliestDeparture: string | null; latestDeparture: string | null; waitingMinutes: number | null;
  breaksBefore: number; restBefore: boolean; appointmentAt: string | null; verdict: TerminVerdict | 'NONE' | 'UNKNOWN';
};
export type TerminCandidate = { label: string; at: string; atLocal: string; verdict: TerminVerdict; deltaMinutes: number; note: string };
export type TerminDriver =
  | { source: 'WEBFLEET'; referenceTime: string; workState: number | null; activitySince: string | null; hours: {
      drivenTodaySeconds: number; dailyDriveLeftSeconds: number; continuousDriveLeftSeconds: number; breakSeconds: number;
      shiftEndAt: string | null; restLatestAt: string | null; restSeconds: number; earliestNextShiftAt: string | null;
      extendedShiftsLeft: number | null; reducedRestsLeft: number | null; weeklyDriveLeftSeconds: number | null } }
  | { source: 'CALCULATED'; preliminary: boolean; drivingSeconds: number; continuousDrivingSeconds: number };
export type TerminPlan = {
  kind: 'TERMIN'; generatedAt: string; vehicleId: string; vehicleNumber: string; licensePlate: string | null;
  source: 'WEBFLEET' | 'CALCULATED'; preliminary: boolean;
  start: { at: string; atLocal: string; label: string; address: string | null; positionSource: 'WEBFLEET' | 'CALCULATED' | 'MANUAL' | null; stale: boolean };
  target: { index: number; stopId: string | null; label: string; type: PlannerStopType; appointmentAt: string | null; terminRequired: boolean };
  stops: TerminStopResult[]; timeline: TerminSegment[];
  recommendation: { terminAt: string | null; terminAtLocal: string | null; basedOnArrival: string | null; bufferMinutes: number; afterDailyRest: boolean; restEndsAt: string | null; reason: string };
  candidates: TerminCandidate[];
  driver: TerminDriver | null;
  warnings: string[]; notes: string[]; geometry: Array<[number, number]>; routingProviders: string[];
};

const BERLIN_DAY = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const BERLIN_TIME = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const BERLIN_DATE = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' });
/** "14:02" today, otherwise "06.11, 06:30": the model and the card never convert time zones themselves. */
export function berlinLocal(value: Date | string, now: Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const time = BERLIN_TIME.format(date);
  return BERLIN_DAY.format(date) === BERLIN_DAY.format(now) ? time : `${BERLIN_DATE.format(date)}, ${time}`;
}
export function formatSeconds(seconds: number): string {
  const minutes = Math.round(Math.abs(seconds) / MINUTE);
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours && rest ? `${hours} ч ${rest} мин` : hours ? `${hours} ч` : `${rest} мин`;
}
export function roundUpToQuarter(at: Date): Date {
  const quarter = 15 * 60_000;
  return new Date(Math.ceil(at.getTime() / quarter) * quarter);
}
export function recommendTermin(earliestArrival: Date): Date {
  return roundUpToQuarter(new Date(earliestArrival.getTime() + TERMIN_BUFFER_MINUTES * 60_000));
}
/** Before the earliest arrival the truck is late; between earliest and latest it depends on the stops before; after the latest it waits. */
export function evaluateCandidate(at: Date, earliest: Date, latest: Date): { verdict: TerminVerdict; deltaMinutes: number } {
  if (at < earliest) return { verdict: 'LATE', deltaMinutes: Math.ceil((earliest.getTime() - at.getTime()) / 60_000) };
  if (at < latest) return { verdict: 'RISK', deltaMinutes: Math.ceil((latest.getTime() - at.getTime()) / 60_000) };
  return { verdict: 'OK', deltaMinutes: Math.floor((at.getTime() - earliest.getTime()) / 60_000) };
}

/**
 * The driver's day as the tachograph in Webfleet sees it. `next_break` and `remain_driving_today` are driving budgets
 * counted from `reference_time`: they shrink only while the truck drives, so the planner subtracts the time driven since
 * the report only when the driver is at the wheel now.
 */
export function driverBudgetFromWebfleet(times: WebfleetDrivingTimes, activity: Pick<WebfleetDriverActivity, 'workState' | 'since'> | null, now: Date): DriverBudget | null {
  if (!times.referenceTime) return null;
  const reference = Date.parse(times.referenceTime);
  if (!Number.isFinite(reference) || now.getTime() - reference > TIMES_MAX_AGE_MS) return null;
  const workState = activity?.workState ?? null;
  const driven = workState === WORK_STATE_DRIVING ? Math.max(0, (now.getTime() - reference) / 1000) : 0;
  const budget = (ms: number | null, fallback: number) => ms === null ? fallback : ms / 1000 - driven;
  const left = (max: number | null, used: number | null) => max === null || used === null ? null : Math.max(0, max - used);
  let continuousDriveLeftSeconds = times.nextBreakAt ? (Date.parse(times.nextBreakAt) - reference) / 1000 - driven : CONTINUOUS_DRIVE_SECONDS;
  let breakRemainingSeconds = 0;
  if (workState === WORK_STATE_BREAK && activity?.since) {
    const resting = (now.getTime() - Date.parse(activity.since)) / 1000;
    const needed = times.nextBreakMinMs !== null ? times.nextBreakMinMs / 1000 : BREAK_SECONDS;
    // A pause that already counts on the tachograph is finished in the plan, then the driver has a full 4 h 30 again.
    if (resting >= MIN_BREAK_PART_SECONDS) { breakRemainingSeconds = Math.max(0, needed - resting); continuousDriveLeftSeconds = CONTINUOUS_DRIVE_SECONDS; }
  }
  const shiftEnd = [times.latestShiftEndAt, times.nextRestAt].filter((value): value is string => Boolean(value)).sort()[0] ?? null;
  return {
    referenceTime: times.referenceTime, workState, activitySince: activity?.since ?? null,
    continuousDriveLeftSeconds: Math.max(0, continuousDriveLeftSeconds),
    breakSeconds: times.nextBreakMinMs !== null && times.nextBreakMinMs > 0 ? times.nextBreakMinMs / 1000 : BREAK_SECONDS,
    dailyDriveLeftSeconds: Math.max(0, budget(times.remainDrivingTodayMs, DAILY_DRIVE_SECONDS)),
    drivenTodaySeconds: (times.totalDrivingTodayMs ?? 0) / 1000 + driven,
    maxDailyDriveSeconds: times.maxDrivingTodayMs !== null ? times.maxDrivingTodayMs / 1000 : DAILY_DRIVE_SECONDS,
    shiftEndAt: shiftEnd, restLatestAt: times.nextRestAt,
    restSeconds: times.nextRestMinMs !== null && times.nextRestMinMs > 0 ? times.nextRestMinMs / 1000 : DAILY_REST_SECONDS,
    weeklyDriveLeftSeconds: times.remainDrivingWeekMs === null ? null : times.remainDrivingWeekMs / 1000 - driven,
    extendedShiftsLeft: left(times.maxExtendedShifts, times.extendedShiftsUsed),
    reducedRestsLeft: left(times.maxReducedRests, times.reducedRestsUsed),
    earliestNextShiftAt: times.earliestNextShiftAt,
    breakRemainingSeconds
  };
}

export type Piece = { type: TerminSegmentType; startAt: Date; endAt: Date; durationSeconds: number; note?: string };
type IdleResult = { countedAs: 'NONE' | 'BREAK' | 'DAILY_REST'; note?: string };
export interface DriveEngine {
  /** Drives for `seconds` from `from`; `restSeconds` is the daily rest to insert on the way (the engine's own when omitted). */
  drive(seconds: number, from: Date, restSeconds?: number): { endAt: Date; pieces: Piece[] };
  idle(seconds: number, from: Date): IdleResult;
  clone(): DriveEngine;
  /** Whose hours these are: the Webfleet tachograph or the calculated vehicle clock. */
  readonly source: DriveEtaPlan['hours'];
  readonly preliminary: boolean;
  /** Whether a 9 h rest may still be taken (unknown counts as yes; the calculated clock never shortens by itself). */
  canReduceRest(): boolean;
  readonly notes: Set<string>;
  readonly warnings: Set<string>;
}

/** Simulates driving on the tachograph budgets: breaks, daily rests and the shift window are inserted where the law requires them. */
export class WebfleetEngine implements DriveEngine {
  readonly source = 'TACHOGRAPH' as const;
  readonly preliminary = false;
  readonly notes = new Set<string>();
  readonly warnings = new Set<string>();
  private contLeft: number; private breakLen: number; private dayLeft: number; private shiftEndMs: number | null;
  private weekLeft: number | null; private reducedLeft: number | null; private pendingBreak: number; private rests = 0;
  constructor(private readonly budget: DriverBudget, private readonly restSeconds: number = DAILY_REST_SECONDS) {
    this.contLeft = budget.continuousDriveLeftSeconds; this.breakLen = budget.breakSeconds; this.dayLeft = budget.dailyDriveLeftSeconds;
    this.shiftEndMs = budget.shiftEndAt ? Date.parse(budget.shiftEndAt) : null;
    this.weekLeft = budget.weeklyDriveLeftSeconds; this.reducedLeft = budget.reducedRestsLeft; this.pendingBreak = budget.breakRemainingSeconds;
  }
  clone(): DriveEngine {
    const copy = new WebfleetEngine(this.budget, this.restSeconds);
    Object.assign(copy, { contLeft: this.contLeft, breakLen: this.breakLen, dayLeft: this.dayLeft, shiftEndMs: this.shiftEndMs, weekLeft: this.weekLeft, reducedLeft: this.reducedLeft, pendingBreak: this.pendingBreak, rests: this.rests });
    this.notes.forEach(note => copy.notes.add(note)); this.warnings.forEach(w => copy.warnings.add(w));
    return copy;
  }
  canReduceRest() { return this.reducedLeft === null || this.reducedLeft > 0; }
  drive(seconds: number, from: Date, restSeconds = this.restSeconds) {
    const pieces: Piece[] = [];
    let cursor = from.getTime();
    let remaining = seconds;
    const push = (type: TerminSegmentType, duration: number) => {
      pieces.push({ type, startAt: new Date(cursor), endAt: new Date(cursor + duration * 1000), durationSeconds: duration });
      cursor += duration * 1000;
    };
    const rest = () => {
      push('DAILY_REST', restSeconds);
      if (restSeconds < DAILY_REST_SECONDS && this.reducedLeft !== null) this.reducedLeft = Math.max(0, this.reducedLeft - 1);
      this.newDay(cursor);
    };
    if (this.pendingBreak > 0) { push('BREAK', this.pendingBreak); this.pendingBreak = 0; this.contLeft = CONTINUOUS_DRIVE_SECONDS; this.breakLen = BREAK_SECONDS; }
    let guard = 0;
    while (remaining > 0 && guard++ < 200) {
      const shiftLeft = this.shiftEndMs === null ? Infinity : (this.shiftEndMs - cursor) / 1000;
      if (this.dayLeft <= 0 || shiftLeft <= 0) { rest(); continue; }
      if (this.contLeft <= 0) {
        if (this.breakLen > shiftLeft) { rest(); continue; }
        push('BREAK', this.breakLen); this.contLeft = CONTINUOUS_DRIVE_SECONDS; this.breakLen = BREAK_SECONDS; continue;
      }
      const chunk = Math.min(remaining, this.contLeft, this.dayLeft, shiftLeft);
      push('DRIVE', chunk);
      remaining -= chunk; this.contLeft -= chunk; this.dayLeft -= chunk;
      if (this.weekLeft !== null) this.weekLeft -= chunk;
    }
    if (this.weekLeft !== null && this.weekLeft < 0) this.warnings.add(`Недельный лимит вождения будет исчерпан (превышение ${formatSeconds(-this.weekLeft)}): в расчёте не учтён, только предупреждение.`);
    return { endAt: new Date(cursor), pieces };
  }
  idle(seconds: number, from: Date): IdleResult {
    const end = from.getTime() + seconds * 1000;
    if (seconds >= DAILY_REST_SECONDS) { this.newDay(end); return { countedAs: 'DAILY_REST' }; }
    if (seconds >= REDUCED_REST_SECONDS && this.reducedLeft !== null && this.reducedLeft > 0) {
      this.reducedLeft -= 1; this.newDay(end);
      return { countedAs: 'DAILY_REST', note: 'Стоянка от 9 ч засчитана как сокращённый суточный отдых: расходует один из оставшихся сокращённых отдыхов.' };
    }
    if (seconds >= BREAK_SECONDS) {
      this.contLeft = CONTINUOUS_DRIVE_SECONDS; this.breakLen = BREAK_SECONDS; this.pendingBreak = 0;
      return { countedAs: 'BREAK', note: 'Стоянка от 45 мин засчитана как перерыв, если водитель в это время не работает.' };
    }
    return { countedAs: 'NONE' };
  }
  private newDay(atMs: number) {
    this.rests += 1;
    this.dayLeft = DAILY_DRIVE_SECONDS; this.contLeft = CONTINUOUS_DRIVE_SECONDS; this.breakLen = BREAK_SECONDS; this.pendingBreak = 0;
    this.shiftEndMs = atMs + DUTY_WINDOW_SECONDS * 1000;
    const extended = this.budget.extendedShiftsLeft;
    this.notes.add(extended ? `После суточного отдыха взято 9 ч вождения и смена 13 ч; 10 ч возможны, пока остались удлинённые смены: ${extended}.` : 'После суточного отдыха взято 9 ч вождения и смена 13 ч.');
  }
}

/** The vehicle's calculated clock (no tachograph data): the same algorithm the ETA uses, marked preliminary. */
export class ClockEngine implements DriveEngine {
  readonly source = 'CLOCK' as const;
  readonly notes = new Set<string>();
  readonly warnings = new Set<string>();
  constructor(private state: ClockState) {}
  get preliminary() { return this.state.kind !== 'KNOWN'; }
  canReduceRest() { return false; }
  clone(): DriveEngine { return new ClockEngine(structuredClone(this.state)); }
  private sync(at: Date) {
    const updated = Date.parse(this.state.updatedAt);
    if (at.getTime() > updated) this.state = applyStopTime(this.state, (at.getTime() - updated) / 1000, this.state.updatedAt).state;
  }
  drive(seconds: number, from: Date) {
    this.sync(from);
    const result = forecastDrive(this.state, seconds, from);
    this.state = result.state;
    const pieces: Piece[] = result.segments.filter(segment => segment.type !== 'WAIT').map(segment => ({
      type: segment.type as TerminSegmentType, startAt: new Date(segment.startAt), endAt: new Date(segment.endAt), durationSeconds: segment.durationSeconds }));
    return { endAt: new Date(result.endAt), pieces };
  }
  idle(seconds: number, from: Date): IdleResult {
    this.sync(from);
    const result = applyStopTime(this.state, seconds, from.toISOString());
    this.state = result.state;
    return { countedAs: result.segment?.type === 'DAILY_REST' ? 'DAILY_REST' : result.segment?.type === 'BREAK' ? 'BREAK' : 'NONE' };
  }
}

/** The driver's hours for the ETA: the tachograph budget and, with the card out, when the next shift may begin. */
export type DriverEtaInput = { budget: DriverBudget; startsAt: Date | null };

/**
 * The next day of a driver whose card is out of the truck: the shift begins at `startsAt` (Webfleet's earliest next shift)
 * with a full 9 h of driving and a 13 h window; only the weekly figures and the rests left carry over.
 */
export function driverBudgetAfterRest(times: WebfleetDrivingTimes, startsAt: Date): DriverBudget {
  const left = (max: number | null, used: number | null) => max === null || used === null ? null : Math.max(0, max - used);
  return {
    referenceTime: times.referenceTime ?? startsAt.toISOString(), workState: null, activitySince: null,
    continuousDriveLeftSeconds: CONTINUOUS_DRIVE_SECONDS, breakSeconds: BREAK_SECONDS,
    dailyDriveLeftSeconds: DAILY_DRIVE_SECONDS, drivenTodaySeconds: 0, maxDailyDriveSeconds: DAILY_DRIVE_SECONDS,
    shiftEndAt: new Date(startsAt.getTime() + DUTY_WINDOW_SECONDS * 1000).toISOString(), restLatestAt: null, restSeconds: DAILY_REST_SECONDS,
    weeklyDriveLeftSeconds: times.remainDrivingWeekMs === null ? null : times.remainDrivingWeekMs / 1000,
    extendedShiftsLeft: left(times.maxExtendedShifts, times.extendedShiftsUsed), reducedRestsLeft: left(times.maxReducedRests, times.reducedRestsUsed),
    earliestNextShiftAt: startsAt.toISOString(), breakRemainingSeconds: 0
  };
}

/**
 * The ETA of one drive on the driver's hours. The daily rest on the way is 11 h; when the stop has a Termin that an
 * 11 h rest would miss and a reduced rest is still allowed, the rest is 9 h and the plan says so. The engine that made
 * the chosen forecast is returned, so a chain of stops continues from it.
 */
export function forecastEta(engine: DriveEngine, driveSeconds: number, from: Date, deadlineAt: Date | null, startsAt: Date | null = null): { endAt: Date; plan: DriveEtaPlan; engine: DriveEngine } {
  const start = startsAt && startsAt > from ? startsAt : from;
  const run = (restSeconds: number) => { const copy = engine.clone(); return { engine: copy, ...copy.drive(driveSeconds, start, restSeconds) }; };
  let chosen = run(DAILY_REST_SECONDS);
  let reduced = false;
  const rests = chosen.pieces.some(piece => piece.type === 'DAILY_REST');
  if (rests && deadlineAt && chosen.endAt > deadlineAt && engine.canReduceRest()) { chosen = run(REDUCED_REST_SECONDS); reduced = true; }
  const rest = chosen.pieces.find(piece => piece.type === 'DAILY_REST') ?? null;
  return {
    endAt: chosen.endAt, engine: chosen.engine,
    plan: {
      hours: engine.source, preliminary: engine.preliminary, driveSeconds: Math.round(driveSeconds),
      breakSeconds: Math.round(chosen.pieces.filter(piece => piece.type === 'BREAK').reduce((sum, piece) => sum + piece.durationSeconds, 0)),
      rest: rest ? { startAt: rest.startAt.toISOString(), endAt: rest.endAt.toISOString(), seconds: Math.round(rest.durationSeconds), reduced: reduced || rest.durationSeconds < DAILY_REST_SECONDS } : null,
      startsAt: start > from ? start.toISOString() : null
    }
  };
}

export type PlanTerminInput = {
  now: Date; startAt: Date; stops: PlannerStop[]; targetIndex: number;
  driver: DriverBudget | null; clock: ClockState | null;
  vehicle: { id: string; vehicleNumber: string; licensePlate: string | null };
  start: Omit<TerminPlan['start'], 'at' | 'atLocal'>;
  warnings?: string[]; notes?: string[]; preliminary?: boolean;
  /** «Если Termin в 14:00»: the time the dispatcher asked about. */
  candidateAt?: Date | null;
  geometry?: Array<[number, number]>; routingProviders?: string[];
};

const STOP_WORD: Record<PlannerStopType, string> = { LOAD: 'Загрузка', UNLOAD: 'Выгрузка', VISIT: 'Точка' };

export function planTermin(input: PlanTerminInput): TerminPlan {
  const { now, startAt } = input;
  const warnings = new Set(input.warnings ?? []);
  const notes = new Set(input.notes ?? []);
  const source: TerminPlan['source'] = input.driver ? 'WEBFLEET' : 'CALCULATED';
  const clock = input.clock;
  let preliminary = Boolean(input.preliminary) || !input.driver;
  if (!input.driver) {
    warnings.add('Нет данных тахографа Webfleet: паузы рассчитаны по расчётным часам машины, предварительно.');
    if (clock?.kind !== 'KNOWN') { preliminary = true; warnings.add('Исходные часы машины не заполнены: перерывы и отдых могут понадобиться раньше, чем в расчёте.'); }
  }
  const run = (restSeconds: number) => simulate(input, input.driver ? new WebfleetEngine(input.driver, restSeconds) : new ClockEngine(clock ?? createUnknownClockState(now)));
  const main = run(DAILY_REST_SECONDS);
  main.engineNotes.forEach(note => notes.add(note));
  main.engineWarnings.forEach(w => warnings.add(w));
  const target = input.stops[input.targetIndex]!;
  const targetResult = main.stops[input.targetIndex];
  const earliest = targetResult?.earliestArrival ? new Date(targetResult.earliestArrival) : null;
  const latest = targetResult?.latestArrival ? new Date(targetResult.latestArrival) : null;
  const restsBefore = main.pieces.filter(piece => piece.type === 'DAILY_REST' && earliest && piece.endAt <= earliest);
  const lastRest = restsBefore[restsBefore.length - 1] ?? null;
  const breaksBefore = main.pieces.filter(piece => piece.type === 'BREAK' && earliest && piece.endAt <= earliest).length;
  const terminAt = earliest ? recommendTermin(earliest) : null;
  const sourceText = source === 'WEBFLEET' ? 'по тахографу Webfleet' : 'по расчётным часам машины, предварительно';
  const pauses = [breaksBefore ? `${breaksBefore} × перерыв ${formatSeconds(BREAK_SECONDS)}` : null, restsBefore.length ? `суточный отдых до ${berlinLocal(lastRest!.endAt, now)}` : null].filter(Boolean).join(', ');
  const reason = earliest
    ? `Самое раннее прибытие ${berlinLocal(earliest, now)} ${sourceText}${pauses ? ` (${pauses})` : ' (без пауз в пути)'}; Termin = прибытие + ${TERMIN_BUFFER_MINUTES} мин, округление вверх до 15 мин.`
    : 'Время прибытия не определено: нет позиции машины или маршрута до точки.';
  const candidates: TerminCandidate[] = [];
  const candidate = (label: string, at: Date, note = '') => {
    if (!earliest || !latest) return;
    const verdict = evaluateCandidate(at, earliest, latest);
    candidates.push({ label, at: at.toISOString(), atLocal: berlinLocal(at, now), ...verdict, note: [candidateText(verdict), note].filter(Boolean).join(' ') });
  };
  if (terminAt) candidate('Рекомендуемый', terminAt);
  if (target.appointmentAt) candidate('Текущий Termin', new Date(target.appointmentAt));
  if (input.candidateAt) candidate('По запросу', input.candidateAt);
  if (terminAt) candidate('С запасом +1 ч', new Date(terminAt.getTime() + 60 * 60_000));
  const reducedLeft = input.driver?.reducedRestsLeft ?? 0;
  if (lastRest && input.driver && (reducedLeft > 0 || input.driver.restSeconds <= REDUCED_REST_SECONDS)) {
    const reduced = run(REDUCED_REST_SECONDS);
    const reducedEarliest = reduced.stops[input.targetIndex]?.earliestArrival;
    if (reducedEarliest) {
      const at = recommendTermin(new Date(reducedEarliest));
      candidates.push({ label: 'С сокращённым отдыхом 9 ч', at: at.toISOString(), atLocal: berlinLocal(at, now), verdict: 'RISK', deltaMinutes: Math.round((terminAt!.getTime() - at.getTime()) / 60_000),
        note: `Прибытие ${berlinLocal(new Date(reducedEarliest), now)}, если отдых сократить до 9 ч: расходует один из ${reducedLeft} сокращённых отдыхов. Безопаснее 11 ч.` });
    }
  }
  const driver: TerminDriver | null = input.driver
    ? { source: 'WEBFLEET', referenceTime: input.driver.referenceTime, workState: input.driver.workState, activitySince: input.driver.activitySince, hours: {
        drivenTodaySeconds: Math.round(input.driver.drivenTodaySeconds), dailyDriveLeftSeconds: Math.round(input.driver.dailyDriveLeftSeconds),
        continuousDriveLeftSeconds: Math.round(input.driver.continuousDriveLeftSeconds), breakSeconds: input.driver.breakSeconds,
        shiftEndAt: input.driver.shiftEndAt, restLatestAt: input.driver.restLatestAt, restSeconds: input.driver.restSeconds, earliestNextShiftAt: input.driver.earliestNextShiftAt,
        extendedShiftsLeft: input.driver.extendedShiftsLeft, reducedRestsLeft: input.driver.reducedRestsLeft,
        weeklyDriveLeftSeconds: input.driver.weeklyDriveLeftSeconds === null ? null : Math.round(input.driver.weeklyDriveLeftSeconds) } }
    : clock ? { source: 'CALCULATED', preliminary: clock.kind !== 'KNOWN', drivingSeconds: clock.currentCycle.drivingSeconds, continuousDrivingSeconds: clock.currentCycle.continuousDrivingSeconds } : null;
  return {
    kind: 'TERMIN', generatedAt: now.toISOString(), vehicleId: input.vehicle.id, vehicleNumber: input.vehicle.vehicleNumber, licensePlate: input.vehicle.licensePlate,
    source, preliminary: preliminary || !earliest,
    start: { ...input.start, at: startAt.toISOString(), atLocal: berlinLocal(startAt, now) },
    target: { index: input.targetIndex, stopId: target.stopId, label: target.label, type: target.type, appointmentAt: target.appointmentAt, terminRequired: target.terminRequired },
    stops: main.stops, timeline: main.pieces.map(piece => toSegment(piece, now)),
    recommendation: { terminAt: terminAt?.toISOString() ?? null, terminAtLocal: terminAt ? berlinLocal(terminAt, now) : null, basedOnArrival: earliest?.toISOString() ?? null,
      bufferMinutes: TERMIN_BUFFER_MINUTES, afterDailyRest: Boolean(lastRest), restEndsAt: lastRest?.endAt.toISOString() ?? null, reason },
    candidates, driver, warnings: [...warnings], notes: [...notes], geometry: input.geometry ?? [], routingProviders: input.routingProviders ?? []
  };
}

function candidateText(result: { verdict: TerminVerdict; deltaMinutes: number }): string {
  if (result.verdict === 'LATE') return `опоздание ${result.deltaMinutes} мин даже при минимальных стоянках.`;
  if (result.verdict === 'RISK') return `успевает при коротких стоянках; при максимальных — опоздание до ${result.deltaMinutes} мин.`;
  return result.deltaMinutes ? `успевает, запас ${result.deltaMinutes} мин.` : 'успевает впритык.';
}
function toSegment(piece: Piece & { label?: string; stopId?: string | null }, now: Date): TerminSegment {
  return { type: piece.type, startAt: piece.startAt.toISOString(), endAt: piece.endAt.toISOString(), startLocal: berlinLocal(piece.startAt, now), endLocal: berlinLocal(piece.endAt, now),
    durationSeconds: Math.round(piece.durationSeconds), label: piece.label ?? '', stopId: piece.stopId ?? null };
}

type Labelled = Piece & { label: string; stopId: string | null };
const PIECE_LABEL: Record<TerminSegmentType, string> = { DRIVE: 'Движение', BREAK: 'Перерыв', DAILY_REST: 'Суточный отдых', SERVICE: 'Стоянка на точке', WAIT: 'Ожидание Termin' };

function simulate(input: PlanTerminInput, engine: DriveEngine) {
  const { now, startAt } = input;
  const early = engine, late = engine.clone();
  let cursorE = startAt, cursorL = startAt;
  const pieces: Labelled[] = [];
  const stops: TerminStopResult[] = [];
  let unknown = false;
  let breaks = 0, rests = 0;
  const add = (piece: Piece, stop: PlannerStop, label: string) => {
    pieces.push({ ...piece, label, stopId: stop.stopId });
    if (piece.type === 'BREAK') breaks += 1;
    if (piece.type === 'DAILY_REST') rests += 1;
  };
  for (const [index, stop] of input.stops.entries()) {
    if (index > input.targetIndex) break;
    let arrivalE: Date | null = null, arrivalL: Date | null = null;
    if (unknown) { /* nothing after an unknown route is timed */ }
    else if (stop.arrivedAt) { arrivalE = arrivalL = new Date(Math.min(startAt.getTime(), Date.parse(stop.arrivedAt))); }
    else if (stop.driveSeconds === null) unknown = true;
    else {
      const a = early.drive(stop.driveSeconds, cursorE);
      const b = late.drive(stop.driveSeconds, cursorL);
      a.pieces.forEach(piece => add(piece, stop, piece.type === 'DRIVE' ? `${PIECE_LABEL.DRIVE} → ${stop.label}` : PIECE_LABEL[piece.type]));
      arrivalE = a.endAt; arrivalL = b.endAt;
    }
    const window = stop.appointmentAt ?? stop.appointmentWindowStartAt;
    const serviceStart = window ? Date.parse(window) : 0;
    const serviceE = arrivalE ? new Date(Math.max(arrivalE.getTime(), serviceStart)) : null;
    const serviceL = arrivalL ? new Date(Math.max(arrivalL.getTime(), serviceStart)) : null;
    const waiting = arrivalE && serviceE ? Math.round((serviceE.getTime() - arrivalE.getTime()) / 60_000) : null;
    let departureE: Date | null = null, departureL: Date | null = null;
    if (index < input.targetIndex && arrivalE && arrivalL && serviceE && serviceL) {
      // The target stop ends the plan: its stay is not simulated.
      if (waiting) { add({ type: 'WAIT', startAt: arrivalE, endAt: serviceE, durationSeconds: waiting * 60 }, stop, `${PIECE_LABEL.WAIT} · ${stop.label}`); note(early.idle(waiting * 60, arrivalE)); }
      departureE = new Date(Math.max(startAt.getTime(), serviceE.getTime() + stop.serviceMinMinutes * 60_000));
      departureL = new Date(Math.max(startAt.getTime(), serviceL.getTime() + stop.serviceMaxMinutes * 60_000));
      if (departureE > serviceE) add({ type: 'SERVICE', startAt: serviceE, endAt: departureE, durationSeconds: (departureE.getTime() - serviceE.getTime()) / 1000 }, stop, `${STOP_WORD[stop.type]} · ${stop.label} (${stop.serviceMinMinutes}–${stop.serviceMaxMinutes} мин)`);
      note(early.idle((departureE.getTime() - serviceE.getTime()) / 1000, serviceE));
      note(late.idle((departureL.getTime() - arrivalL.getTime()) / 1000, arrivalL));
      cursorE = departureE; cursorL = departureL;
    }
    const deadline = stop.appointmentAt ?? stop.appointmentWindowEndAt;
    stops.push({ stopId: stop.stopId, label: stop.label, type: stop.type, driveSeconds: stop.driveSeconds,
      earliestArrival: arrivalE?.toISOString() ?? null, latestArrival: arrivalL?.toISOString() ?? null,
      earliestArrivalLocal: arrivalE ? berlinLocal(arrivalE, now) : null, latestArrivalLocal: arrivalL ? berlinLocal(arrivalL, now) : null,
      earliestDeparture: departureE?.toISOString() ?? null, latestDeparture: departureL?.toISOString() ?? null, waitingMinutes: waiting,
      breaksBefore: breaks, restBefore: rests > 0, appointmentAt: stop.appointmentAt,
      verdict: !arrivalE || !arrivalL ? 'UNKNOWN' : deadline ? evaluateCandidate(new Date(deadline), arrivalE, arrivalL).verdict : 'NONE' });
  }
  function note(result: IdleResult) { if (result.note) engine.notes.add(result.note); }
  return { stops, pieces, engineNotes: [...early.notes, ...late.notes], engineWarnings: [...early.warnings, ...late.warnings] };
}
