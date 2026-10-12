const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3600;

export const VEHICLE_CLOCK_LIMITS = {
  breakAfterDrivingSeconds: 4 * HOUR_SECONDS,
  breakDurationSeconds: 45 * MINUTE_SECONDS,
  normalDailyDrivingSeconds: 9 * HOUR_SECONDS,
  extendedDailyDrivingSeconds: 10 * HOUR_SECONDS,
  normalDutyWindowSeconds: 13 * HOUR_SECONDS,
  extendedDutyWindowSeconds: 15 * HOUR_SECONDS,
  normalDailyRestSeconds: 11 * HOUR_SECONDS,
  reducedDailyRestSeconds: 9 * HOUR_SECONDS,
  weeklyExtendedDriveLimit: 2,
  reducedRestsBetweenWeeklyRestsLimit: 3
} as const;

export type ClockKind = "UNKNOWN" | "KNOWN";
export type VehicleClockSegmentType = "DRIVE" | "BREAK" | "DAILY_REST" | "WAIT";
export type ClockExtensionType = "EXTENDED_DRIVE" | "REDUCED_REST";

export interface VehicleClockSegment {
  type: VehicleClockSegmentType;
  startAt: string;
  endAt: string;
  durationSeconds: number;
}

export interface VehicleClockCycle {
  cycleId: string;
  startedAt: string;
  drivingSeconds: number;
  dutySeconds: number;
  continuousDrivingSeconds: number;
  extendedDriveReservationId: string | null;
  reducedRestReservationId: string | null;
  extendedDriveReservationWeek?: string;
}

export interface WeeklyExtendedDriveUsage {
  weekKey: string;
  used: number;
}

export interface ClockState {
  kind: ClockKind;
  updatedAt: string;
  currentCycle: VehicleClockCycle;
  weeklyExtendedDrive: WeeklyExtendedDriveUsage;
  reducedRestsSinceWeeklyRest: number;
  warnings: string[];
  pendingRest?: { type: "BREAK" | "DAILY_REST"; endAt: string };
}

export interface CreateInitialClockInput {
  effectiveAt: string | Date;
  cycleId?: string;
  drivingSeconds?: number;
  dutySeconds?: number;
  continuousDrivingSeconds?: number;
  weeklyExtendedDrive?: WeeklyExtendedDriveUsage;
  reducedRestsSinceWeeklyRest?: number;
  extendedDriveReservationId?: string | null;
  reducedRestReservationId?: string | null;
}

export interface ValidateInitialClockInput {
  drivingSeconds?: number;
  dutySeconds?: number;
  continuousDrivingSeconds?: number;
  extendedDriveReserved?: boolean;
  reducedRestReserved?: boolean;
  reducedRestsSinceWeeklyRest?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ForecastDriveResult {
  endAt: string;
  state: ClockState;
  segments: VehicleClockSegment[];
  plan: VehicleClockPlan;
  isPreliminary: boolean;
  warnings: string[];
}

export interface ApplyStopTimeResult {
  state: ClockState;
  segment: VehicleClockSegment | null;
  warnings: string[];
}

export interface ReserveCycleExtensionInput {
  type: ClockExtensionType;
  reservationId: string;
  requestedAt: string | Date;
}

export interface ReserveCycleExtensionResult {
  state: ClockState;
  accepted: boolean;
  reason: "RESERVED" | "RELEASED" | "ALREADY_RESERVED" | "NOT_RESERVED" | "UNKNOWN_CLOCK" | "LIMIT_REACHED" | "ALREADY_STARTED";
}

export interface ReleaseCycleExtensionInput {
  type: ClockExtensionType;
  reservationId: string;
}

export interface VehicleClockPlanStep {
  segment: VehicleClockSegment;
  stateBefore: ClockState;
  stateAfter: ClockState;
}

export interface VehicleClockPlan {
  startedAt: string;
  endAt: string;
  initialState: ClockState;
  finalState: ClockState;
  steps: VehicleClockPlanStep[];
  isPreliminary: boolean;
  warnings: string[];
}

export interface EvaluatedClockPlan {
  drivenSeconds: number;
  progress: number;
  state: ClockState;
  completedSegments: VehicleClockSegment[];
  activeSegment: VehicleClockSegment | null;
  remainingSegments: VehicleClockSegment[];
  isComplete: boolean;
  warnings: string[];
}

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function asDate(value: string | Date): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * SECOND_MS);
}

function secondsBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / SECOND_MS));
}

function normalizeSeconds(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) throw new Error("Продолжительность должна быть конечным неотрицательным числом");
  return Math.floor(value);
}

function hasNegativeSeconds(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value < 0;
}

function segment(type: VehicleClockSegmentType, startAt: Date, durationSeconds: number): VehicleClockSegment {
  const endAt = addSeconds(startAt, durationSeconds);
  return {
    type,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    durationSeconds
  };
}

function berlinDateParts(value: Date): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(value);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function getBerlinIsoWeekKey(value: string | Date): string {
  const { year, month, day } = berlinDateParts(asDate(value));
  const localMidnight = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = localMidnight.getUTCDay() || 7;
  const thursday = new Date(localMidnight);
  thursday.setUTCDate(localMidnight.getUTCDate() + 4 - dayOfWeek);
  const weekYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstDayOfWeek = firstThursday.getUTCDay() || 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstDayOfWeek);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * HOUR_SECONDS * SECOND_MS));
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

function ensureWeeklyUsageForDate(state: ClockState, value: string | Date): WeeklyExtendedDriveUsage {
  const weekKey = getBerlinIsoWeekKey(value);
  return state.weeklyExtendedDrive.weekKey === weekKey ? state.weeklyExtendedDrive : { weekKey, used: 0 };
}

function normalizeCycle(input: CreateInitialClockInput): VehicleClockCycle {
  const drivingSeconds = normalizeSeconds(input.drivingSeconds);
  const dutySeconds = normalizeSeconds(input.dutySeconds);
  const continuousDrivingSeconds = Math.min(
    normalizeSeconds(input.continuousDrivingSeconds),
    drivingSeconds,
    VEHICLE_CLOCK_LIMITS.breakAfterDrivingSeconds
  );

  return {
    cycleId: input.cycleId ?? `cycle-${iso(input.effectiveAt)}`,
    startedAt: addSeconds(asDate(input.effectiveAt), -dutySeconds).toISOString(),
    drivingSeconds,
    dutySeconds,
    continuousDrivingSeconds,
    extendedDriveReservationId: input.extendedDriveReservationId ?? null,
    reducedRestReservationId: input.reducedRestReservationId ?? null
  };
}

function cloneState(state: ClockState): ClockState {
  return {
    kind: state.kind,
    updatedAt: state.updatedAt,
    currentCycle: { ...state.currentCycle },
    weeklyExtendedDrive: { ...state.weeklyExtendedDrive },
    reducedRestsSinceWeeklyRest: state.reducedRestsSinceWeeklyRest,
    warnings: [...state.warnings],
    pendingRest: state.pendingRest ? { ...state.pendingRest } : undefined
  };
}

function withUpdatedStateAt(state: ClockState, updatedAt: Date): ClockState {
  const next = cloneState(state);
  next.updatedAt = updatedAt.toISOString();
  return next;
}

function newCycle(startAt: Date): VehicleClockCycle {
  return {
    cycleId: `cycle-${startAt.toISOString()}`,
    startedAt: startAt.toISOString(),
    drivingSeconds: 0,
    dutySeconds: 0,
    continuousDrivingSeconds: 0,
    extendedDriveReservationId: null,
    reducedRestReservationId: null
  };
}

function dailyDrivingLimit(cycle: VehicleClockCycle): number {
  return cycle.extendedDriveReservationId
    ? VEHICLE_CLOCK_LIMITS.extendedDailyDrivingSeconds
    : VEHICLE_CLOCK_LIMITS.normalDailyDrivingSeconds;
}

function dutyWindowLimit(cycle: VehicleClockCycle): number {
  return cycle.reducedRestReservationId
    ? VEHICLE_CLOCK_LIMITS.extendedDutyWindowSeconds
    : VEHICLE_CLOCK_LIMITS.normalDutyWindowSeconds;
}

function dailyRestDuration(cycle: VehicleClockCycle): number {
  return cycle.reducedRestReservationId
    ? VEHICLE_CLOCK_LIMITS.reducedDailyRestSeconds
    : VEHICLE_CLOCK_LIMITS.normalDailyRestSeconds;
}

export function createUnknownClockState(effectiveAt: string | Date): ClockState {
  const at = iso(effectiveAt);
  return {
    kind: "UNKNOWN",
    updatedAt: at,
    currentCycle: newCycle(asDate(effectiveAt)),
    weeklyExtendedDrive: { weekKey: getBerlinIsoWeekKey(effectiveAt), used: 0 },
    reducedRestsSinceWeeklyRest: 0,
    warnings: ["CLOCK_STATE_UNKNOWN"]
  };
}

export function validateInitialClock(input: ValidateInitialClockInput): ValidationResult {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "number" && (!Number.isFinite(value) || !Number.isInteger(value))) errors.push(`${key.toUpperCase()}_INVALID`);
  }
  const drivingSeconds = input.drivingSeconds ?? 0;
  const dutySeconds = input.dutySeconds ?? 0;
  const continuousDrivingSeconds = input.continuousDrivingSeconds ?? 0;
  const drivingLimit = input.extendedDriveReserved
    ? VEHICLE_CLOCK_LIMITS.extendedDailyDrivingSeconds
    : VEHICLE_CLOCK_LIMITS.normalDailyDrivingSeconds;
  const dutyLimit = input.reducedRestReserved
    ? VEHICLE_CLOCK_LIMITS.extendedDutyWindowSeconds
    : VEHICLE_CLOCK_LIMITS.normalDutyWindowSeconds;

  if (hasNegativeSeconds(input.drivingSeconds)) errors.push("DRIVING_SECONDS_NEGATIVE");
  if (hasNegativeSeconds(input.dutySeconds)) errors.push("DUTY_SECONDS_NEGATIVE");
  if (hasNegativeSeconds(input.continuousDrivingSeconds)) errors.push("CONTINUOUS_DRIVING_SECONDS_NEGATIVE");
  if (input.reducedRestsSinceWeeklyRest !== undefined && input.reducedRestsSinceWeeklyRest < 0) {
    errors.push("REDUCED_REST_COUNTER_NEGATIVE");
  }
  if (input.dutySeconds !== undefined && drivingSeconds > dutySeconds) errors.push("DRIVING_EXCEEDS_DUTY");
  if (drivingSeconds > drivingLimit) errors.push("DRIVING_SECONDS_EXCEED_LIMIT");
  if (dutySeconds > dutyLimit) errors.push("DUTY_SECONDS_EXCEED_LIMIT");
  if (continuousDrivingSeconds > VEHICLE_CLOCK_LIMITS.breakAfterDrivingSeconds) {
    errors.push("CONTINUOUS_DRIVING_SECONDS_EXCEED_BREAK_LIMIT");
  }
  if (continuousDrivingSeconds > drivingSeconds) errors.push("CONTINUOUS_DRIVING_EXCEEDS_TOTAL_DRIVING");
  if (input.reducedRestsSinceWeeklyRest !== undefined) {
    const reduced = input.reducedRestsSinceWeeklyRest;
    if (reduced > VEHICLE_CLOCK_LIMITS.reducedRestsBetweenWeeklyRestsLimit) {
      errors.push("REDUCED_REST_COUNTER_EXCEEDS_LIMIT");
    }
  }

  return { valid: errors.length === 0, errors };
}

export function createInitialClockState(input: CreateInitialClockInput): ClockState {
  const validation = validateInitialClock({ ...input, extendedDriveReserved: Boolean(input.extendedDriveReservationId), reducedRestReserved: Boolean(input.reducedRestReservationId) });
  if (!validation.valid) throw new Error(validation.errors.join(", "));
  if (input.weeklyExtendedDrive && (!Number.isInteger(input.weeklyExtendedDrive.used) || input.weeklyExtendedDrive.used < 0 || input.weeklyExtendedDrive.used > 2)) throw new Error("WEEKLY_EXTENDED_COUNTER_INVALID");
  const cycle = normalizeCycle(input);
  const weeklyExtendedDrive =
    input.weeklyExtendedDrive && input.weeklyExtendedDrive.weekKey
      ? { ...input.weeklyExtendedDrive, used: Math.max(0, Math.floor(input.weeklyExtendedDrive.used)) }
      : { weekKey: getBerlinIsoWeekKey(input.effectiveAt), used: 0 };

  return {
    kind: "KNOWN",
    updatedAt: iso(input.effectiveAt),
    currentCycle: cycle,
    weeklyExtendedDrive,
    reducedRestsSinceWeeklyRest: Math.max(0, Math.floor(input.reducedRestsSinceWeeklyRest ?? 0)),
    warnings: []
  };
}

export function reserveCycleExtension(
  state: ClockState,
  input: ReserveCycleExtensionInput
): ReserveCycleExtensionResult {
  const next = cloneState(state);
  if (!input.reservationId.trim()) throw new Error("Необходимо указать идентификатор резерва");

  if (next.kind === "UNKNOWN") {
    return { state: next, accepted: false, reason: "UNKNOWN_CLOCK" };
  }

  if (input.type === "EXTENDED_DRIVE") {
    if (next.currentCycle.extendedDriveReservationId === input.reservationId) {
      return { state: next, accepted: true, reason: "ALREADY_RESERVED" };
    }
    if (next.currentCycle.extendedDriveReservationId) {
      return { state: next, accepted: false, reason: "LIMIT_REACHED" };
    }

    next.weeklyExtendedDrive = ensureWeeklyUsageForDate(next, input.requestedAt);
    if (next.weeklyExtendedDrive.used >= VEHICLE_CLOCK_LIMITS.weeklyExtendedDriveLimit) {
      return { state: next, accepted: false, reason: "LIMIT_REACHED" };
    }

    next.weeklyExtendedDrive.used += 1;
    next.currentCycle.extendedDriveReservationId = input.reservationId;
    next.currentCycle.extendedDriveReservationWeek = next.weeklyExtendedDrive.weekKey;
    return { state: next, accepted: true, reason: "RESERVED" };
  }

  if (next.currentCycle.reducedRestReservationId === input.reservationId) {
    return { state: next, accepted: true, reason: "ALREADY_RESERVED" };
  }
  if (next.currentCycle.reducedRestReservationId) {
    return { state: next, accepted: false, reason: "LIMIT_REACHED" };
  }
  if (next.reducedRestsSinceWeeklyRest >= VEHICLE_CLOCK_LIMITS.reducedRestsBetweenWeeklyRestsLimit) {
    return { state: next, accepted: false, reason: "LIMIT_REACHED" };
  }

  next.reducedRestsSinceWeeklyRest += 1;
  next.currentCycle.reducedRestReservationId = input.reservationId;
  return { state: next, accepted: true, reason: "RESERVED" };
}

export function releaseCycleExtension(state: ClockState, input: ReleaseCycleExtensionInput): ReserveCycleExtensionResult {
  const next = cloneState(state);

  if (next.kind === "UNKNOWN") {
    return { state: next, accepted: false, reason: "UNKNOWN_CLOCK" };
  }

  if (
    input.type === "EXTENDED_DRIVE" &&
    next.currentCycle.extendedDriveReservationId === input.reservationId
  ) {
    if (next.currentCycle.drivingSeconds > VEHICLE_CLOCK_LIMITS.normalDailyDrivingSeconds) {
      return { state: next, accepted: false, reason: "ALREADY_STARTED" };
    }
    next.currentCycle.extendedDriveReservationId = null;
    if (!next.currentCycle.extendedDriveReservationWeek || next.currentCycle.extendedDriveReservationWeek === next.weeklyExtendedDrive.weekKey) next.weeklyExtendedDrive.used = Math.max(0, next.weeklyExtendedDrive.used - 1);
    delete next.currentCycle.extendedDriveReservationWeek;
    return { state: next, accepted: true, reason: "RELEASED" };
  }

  if (input.type === "REDUCED_REST" && next.currentCycle.reducedRestReservationId === input.reservationId) {
    if (next.currentCycle.dutySeconds > VEHICLE_CLOCK_LIMITS.normalDutyWindowSeconds || next.pendingRest?.type === "DAILY_REST") {
      return { state: next, accepted: false, reason: "ALREADY_STARTED" };
    }
    next.currentCycle.reducedRestReservationId = null;
    next.reducedRestsSinceWeeklyRest = Math.max(0, next.reducedRestsSinceWeeklyRest - 1);
    return { state: next, accepted: true, reason: "RELEASED" };
  }

  return { state: next, accepted: true, reason: "NOT_RESERVED" };
}

export function resetReducedRestCounter(state: ClockState, effectiveAt: string | Date): ClockState {
  const next = cloneState(state);
  next.reducedRestsSinceWeeklyRest = 0;
  next.currentCycle = newCycle(asDate(effectiveAt));
  next.pendingRest = undefined;
  next.updatedAt = iso(effectiveAt);
  return next;
}

export function applyStopTime(state: ClockState, stopSeconds: number, startedAt: string | Date): ApplyStopTimeResult {
  const next = cloneState(state);
  const durationSeconds = normalizeSeconds(stopSeconds);
  const start = asDate(startedAt);

  if (durationSeconds <= 0) {
    return { state: next, segment: null, warnings: [...next.warnings] };
  }

  next.currentCycle.dutySeconds += durationSeconds;
  next.updatedAt = addSeconds(start, durationSeconds).toISOString();
  const warnings = [...next.warnings];
  if (next.currentCycle.dutySeconds > dutyWindowLimit(next.currentCycle)) {
    if (!warnings.includes("DUTY_WINDOW_EXCEEDED_BY_STOP")) warnings.push("DUTY_WINDOW_EXCEEDED_BY_STOP");
  }
  next.warnings = warnings;

  return {
    state: next,
    segment: segment("WAIT", start, durationSeconds),
    warnings
  };
}

export function forecastDrive(state: ClockState, drivingSeconds: number, now: Date): ForecastDriveResult {
  if (!Number.isFinite(now.getTime())) throw new Error("Некорректное время прогноза");
  const next = cloneState(state);
  const segments: VehicleClockSegment[] = [];
  const steps: VehicleClockPlanStep[] = [];
  const warnings = [...next.warnings];
  const isPreliminary = next.kind === "UNKNOWN";
  const initialState = cloneState(next);
  let cursor = new Date(now.getTime());
  let remainingDrivingSeconds = normalizeSeconds(drivingSeconds);

  if (isPreliminary && !warnings.includes("CLOCK_STATE_UNKNOWN")) warnings.push("CLOCK_STATE_UNKNOWN");

  const pushStep = (nextSegment: VehicleClockSegment, stateBefore: ClockState, stateAfter: ClockState) => {
    segments.push(nextSegment);
    steps.push({
      segment: nextSegment,
      stateBefore: cloneState(stateBefore),
      stateAfter: cloneState(stateAfter)
    });
  };

  if (next.pendingRest) {
    const before = cloneState(next);
    const type = next.pendingRest.type;
    const end = asDate(next.pendingRest.endAt);
    const remaining = secondsBetween(cursor, end);
    if (type === "DAILY_REST") next.currentCycle = newCycle(end);
    else {
      next.currentCycle.dutySeconds += remaining;
      next.currentCycle.continuousDrivingSeconds = 0;
    }
    next.pendingRest = undefined;
    if (remaining > 0) {
      const rest = segment(type, cursor, remaining);
      cursor = addSeconds(cursor, remaining);
      next.updatedAt = cursor.toISOString();
      pushStep(rest, before, next);
    }
  }

  while (remainingDrivingSeconds > 0) {
    const cycle = next.currentCycle;
    const drivingRemainingToday = dailyDrivingLimit(cycle) - cycle.drivingSeconds;
    const dutyRemainingToday = dutyWindowLimit(cycle) - cycle.dutySeconds;

    if (drivingRemainingToday <= 0 || dutyRemainingToday <= 0) {
      const restSeconds = dailyRestDuration(cycle);
      const before = cloneState(next);
      const rest = segment("DAILY_REST", cursor, restSeconds);
      cursor = addSeconds(cursor, restSeconds);
      next.currentCycle = newCycle(cursor);
      next.updatedAt = cursor.toISOString();
      pushStep(rest, before, next);
      continue;
    }

    const continuousRemaining = VEHICLE_CLOCK_LIMITS.breakAfterDrivingSeconds - cycle.continuousDrivingSeconds;
    if (continuousRemaining <= 0) {
      if (dutyRemainingToday <= VEHICLE_CLOCK_LIMITS.breakDurationSeconds) {
        const restSeconds = dailyRestDuration(cycle);
        const before = cloneState(next);
        const rest = segment("DAILY_REST", cursor, restSeconds);
        cursor = addSeconds(cursor, restSeconds);
        next.currentCycle = newCycle(cursor);
        next.updatedAt = cursor.toISOString();
        pushStep(rest, before, next);
        continue;
      }

      const before = cloneState(next);
      const restBreak = segment("BREAK", cursor, VEHICLE_CLOCK_LIMITS.breakDurationSeconds);
      cursor = addSeconds(cursor, VEHICLE_CLOCK_LIMITS.breakDurationSeconds);
      cycle.dutySeconds += VEHICLE_CLOCK_LIMITS.breakDurationSeconds;
      cycle.continuousDrivingSeconds = 0;
      next.updatedAt = cursor.toISOString();
      pushStep(restBreak, before, next);
      continue;
    }

    const chunk = Math.min(remainingDrivingSeconds, continuousRemaining, drivingRemainingToday, dutyRemainingToday);

    if (chunk <= 0) {
      const restSeconds = dailyRestDuration(cycle);
      const before = cloneState(next);
      const rest = segment("DAILY_REST", cursor, restSeconds);
      cursor = addSeconds(cursor, restSeconds);
      next.currentCycle = newCycle(cursor);
      next.updatedAt = cursor.toISOString();
      pushStep(rest, before, next);
      continue;
    }

    const before = cloneState(next);
    const drive = segment("DRIVE", cursor, chunk);
    cursor = addSeconds(cursor, chunk);
    cycle.drivingSeconds += chunk;
    cycle.dutySeconds += chunk;
    cycle.continuousDrivingSeconds += chunk;
    remainingDrivingSeconds -= chunk;
    next.updatedAt = cursor.toISOString();
    pushStep(drive, before, next);
  }

  next.warnings = warnings;
  const plan: VehicleClockPlan = {
    startedAt: now.toISOString(),
    endAt: cursor.toISOString(),
    initialState,
    finalState: cloneState(next),
    steps,
    isPreliminary,
    warnings
  };

  return {
    endAt: cursor.toISOString(),
    state: next,
    segments,
    plan,
    isPreliminary,
    warnings
  };
}

function applyPartialSegment(step: VehicleClockPlanStep, at: Date): ClockState {
  const start = asDate(step.segment.startAt);
  const elapsed = Math.min(step.segment.durationSeconds, secondsBetween(start, at));
  const next = withUpdatedStateAt(step.stateBefore, addSeconds(start, elapsed));
  if (step.segment.type === "BREAK" || step.segment.type === "DAILY_REST") next.pendingRest = { type: step.segment.type, endAt: step.segment.endAt };

  if (step.segment.type === "DRIVE") {
    next.currentCycle.drivingSeconds += elapsed;
    next.currentCycle.dutySeconds += elapsed;
    next.currentCycle.continuousDrivingSeconds += elapsed;
    return next;
  }

  if (step.segment.type === "BREAK" || step.segment.type === "WAIT") {
    next.currentCycle.dutySeconds += elapsed;
    return next;
  }

  return next;
}

export function evaluateClockPlan(plan: VehicleClockPlan, at: Date): EvaluatedClockPlan {
  const completedSegments: VehicleClockSegment[] = [];
  const total = plan.steps.reduce((sum, step) => sum + (step.segment.type === "DRIVE" ? step.segment.durationSeconds : 0), 0);
  const drivenSeconds = plan.steps.reduce((sum, step) => sum + (step.segment.type === "DRIVE" ? Math.min(step.segment.durationSeconds, secondsBetween(asDate(step.segment.startAt), at)) : 0), 0);
  const progress = total > 0 ? drivenSeconds / total : (at >= asDate(plan.endAt) ? 1 : 0);

  for (const [index, step] of plan.steps.entries()) {
    const start = asDate(step.segment.startAt);
    const end = asDate(step.segment.endAt);

    if (at >= end) {
      completedSegments.push(step.segment);
      continue;
    }

    if (at >= start) {
      return {
        drivenSeconds, progress,
        state: applyPartialSegment(step, at),
        completedSegments,
        activeSegment: step.segment,
        remainingSegments: plan.steps.slice(index + 1).map((remaining) => remaining.segment),
        isComplete: false,
        warnings: [...plan.warnings]
      };
    }

    return {
      drivenSeconds, progress,
      state: withUpdatedStateAt(step.stateBefore, at),
      completedSegments,
      activeSegment: null,
      remainingSegments: plan.steps.slice(index).map((remaining) => remaining.segment),
      isComplete: false,
      warnings: [...plan.warnings]
    };
  }

  return {
    drivenSeconds, progress,
    state: at >= asDate(plan.endAt) ? cloneState(plan.finalState) : withUpdatedStateAt(plan.initialState, at),
    completedSegments,
    activeSegment: null,
    remainingSegments: [],
    isComplete: true,
    warnings: [...plan.warnings]
  };
}

export function stateAt(stateOrPlan: ClockState | VehicleClockPlan, now: Date): ClockState {
  if ("steps" in stateOrPlan) return evaluateClockPlan(stateOrPlan, now).state;

  const state = stateOrPlan;
  const next = cloneState(state);
  const elapsed = secondsBetween(asDate(state.updatedAt), now);
  if (elapsed <= 0) return next;
  next.updatedAt = now.toISOString();
  return next;
}
