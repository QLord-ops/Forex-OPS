import type { PrismaClient } from '@prisma/client';
import type { CurrentPosition } from '../domain.js';
import { berlinLocalToDate } from './appointment-match.js';
import { writeAuditLog, type AuditActor } from './audit-log.js';
import type { EtaService } from './eta.js';
import { berlinToday } from './order-dates.js';
import { stopActivityOf } from './rest-at-stop.js';
import { DAILY_REST_SECONDS, driverBudgetFromWebfleet, planTermin, TERMIN_BUFFER_MINUTES, type DriverBudget, type PlannerStop } from './termin-planner.js';
import { buildPlannerStops, type DriveEstimate } from './termin-service.js';
import { snapshotVehicleClock } from './tours.js';
import { distanceMeters } from './webfleet.js';
import type { DriverHours, WebfleetDrivingTimes } from './webfleet-live.js';
import { withZuladungNote } from './zuladung.js';
import { parseProfile } from './customer-profile.js';

/** The list before customers existed: Schnellecke, blocks NORD / SÜD / LuFe. Used until a Schnellecke customer is set up. */
export const STATUS_LINE = 'SCHNELLECKE';
export const STATUS_GROUP_ORDER = ['NORD', 'SUED', 'LUFE'] as const;

/** One customer's daily list: its key (the customer slug), blocks (lines), columns and due time. */
export type StatusListConfig = {
  key: string;
  customerId: string | null;
  name: string;
  dueLocalTime: string;
  groups: Array<{ code: string; name: string }>;
  excludedVehicles: string[];
  columns: { we: string | null; aSchild: boolean; appSped: boolean };
};

export const LEGACY_STATUS_LIST: StatusListConfig = {
  key: STATUS_LINE, customerId: null, name: 'Schnellecke', dueLocalTime: '07:00',
  groups: [{ code: 'NORD', name: 'NORD' }, { code: 'SUED', name: 'SÜD' }, { code: 'LUFE', name: 'LuFe' }],
  excludedVehicles: [], columns: { we: 'WE in Northeim', aSchild: true, appSped: true }
};
/** Without a Termin and without tachograph data the driver is assumed to start at this time. */
const DEFAULT_START_LOCAL_TIME = '06:00';
/** After a restart the Webfleet figures refill within minutes: wait this long before a list with missing data. */
const WEBFLEET_GRACE_MS = 10 * 60_000;
/** A generation that has not finished within this time is taken over by the next tick. */
const STALE_GENERATION_MS = 5 * 60_000;
/** A tachograph shift start older than this is yesterday's shift, not today's. */
const TACHO_SHIFT_MAX_AGE_MS = 16 * 3600_000;
/** Only a Termin this close decides today's start. */
const TERMIN_HORIZON_MS = 36 * 3600_000;
/** Straight line → road and an average truck speed: only when no stored leg and no planned approach exist. */
const ROAD_FACTOR = 1.3;
const OFFLINE_SPEED_KMH = 70;

/** All texts the customer reads, in German and in one place, so the dispatcher can confirm the wording. */
export const STATUS_TEXT_DE = {
  STUCK_UNLOAD_YESTERDAY: 'Fahrzeug konnte gestern nicht entladen werden',
  STUCK_LOAD_YESTERDAY: 'Fahrzeug konnte gestern nicht beladen werden',
  STUCK_UNLOAD_SINCE: (day: string) => `Fahrzeug steht seit dem ${day} und konnte noch nicht entladen werden`,
  STUCK_LOAD_SINCE: (day: string) => `Fahrzeug steht seit dem ${day} und konnte noch nicht beladen werden`,
  EMPTY: 'Fahrzeug ist leer',
  AT_UNLOAD: 'Fahrzeug steht an der Entladestelle',
  AT_LOAD: 'Fahrzeug steht an der Ladestelle',
  TERMIN_AT_RISK: (eta: string, termin: string) => `Ankunft voraussichtlich ca. ${eta} – Termin ${termin} gefährdet`
} as const;

export type StatusRule = 'STUCK' | 'EMPTY' | 'AT_STOP' | 'EN_ROUTE';
export type StartKind = 'TACHO' | 'TERMIN_LATEST' | 'AFTER_REST' | 'DEFAULT' | 'NONE';
export type AnkunftKind = 'TERMIN' | 'ETA' | 'ARRIVED' | 'NONE';
export type StatusFlag = 'NO_WEBFLEET' | 'GPS_STALE' | 'NO_GPS' | 'TACHO_MISSING' | 'ROUTE_ESTIMATE' | 'PRELIMINARY' | 'TERMIN_AT_RISK';
export type StartEstimate = { at: Date | null; kind: StartKind; terminFeasible?: boolean; arrivalFromEarliest?: Date | null };

const BERLIN_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const BERLIN_TIME = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const BERLIN_DATE = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' });

/** "07:15" on the list's day, otherwise "06.11. 07:15". */
export function statusTime(at: Date | string | null | undefined, dayKey: string): string {
  if (!at) return '';
  const date = typeof at === 'string' ? new Date(at) : at;
  const time = BERLIN_TIME.format(date);
  return BERLIN_DAY.format(date) === dayKey ? time : `${BERLIN_DATE.format(date)} ${time}`;
}
export function dayStartOf(dayKey: string): Date { return berlinLocalToDate(`${dayKey}T00:00`)!; }
function previousDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/**
 * The town in a Webfleet address: "Musterstr. 1, 37083 Göttingen, DE" → Göttingen, "A7, Göttingen" → Göttingen,
 * "VW Emden (VW-LKW-Tor), 26723 Emden" → Emden. A bare road number has no town.
 */
export function cityOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length && /^[A-Z]{2}$/.test(parts[parts.length - 1])) parts.pop();
  const clean = (value: string) => value.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+OT\s+.*$/i, '').replace(/\s+-\s+.*$/, '').trim() || null;
  for (const part of [...parts].reverse()) {
    const match = /^(?:D-)?\d{4,5}\s+(.+)$/.exec(part);
    if (match) return clean(match[1]);
  }
  for (const part of [...parts].reverse()) {
    if (/^(A|B|E|L|K)\s?\d+[a-z]?$/i.test(part) || /\d/.test(part.split(' ')[0] ?? '')) continue;
    if (/(straße|strasse|str\.|weg|allee|platz|ring|damm|chaussee)\b/i.test(part)) continue;
    return clean(part);
  }
  return null;
}

/** A driver who has not started yet: a full day from `startAt` (4 h 30 to the first break, 9 h driving, 13 h shift). */
export function freshDayBudget(startAt: Date, times: WebfleetDrivingTimes | null): DriverBudget {
  const iso = startAt.toISOString();
  const shiftEnd = new Date(startAt.getTime() + 13 * 3600_000).toISOString();
  return {
    referenceTime: iso, workState: null, activitySince: null,
    continuousDriveLeftSeconds: 4.5 * 3600, breakSeconds: 45 * 60, dailyDriveLeftSeconds: 9 * 3600, drivenTodaySeconds: 0, maxDailyDriveSeconds: 9 * 3600,
    shiftEndAt: shiftEnd, restLatestAt: shiftEnd, restSeconds: DAILY_REST_SECONDS,
    weeklyDriveLeftSeconds: times?.remainDrivingWeekMs != null ? times.remainDrivingWeekMs / 1000 : null,
    extendedShiftsLeft: null, reducedRestsLeft: 0, earliestNextShiftAt: null, breakRemainingSeconds: 0
  };
}

type PlanVehicle = { id: string; vehicleNumber: string; licensePlate: string | null };
const PLAN_START = { label: 'Start', address: null, positionSource: null, stale: false } as const;
function arrivalFrom(stops: PlannerStop[], targetIndex: number, startAt: Date, vehicle: PlanVehicle, times: WebfleetDrivingTimes | null): Date | null {
  const plan = planTermin({ now: startAt, startAt, stops, targetIndex, driver: freshDayBudget(startAt, times), clock: null, vehicle, start: PLAN_START });
  const at = plan.stops[targetIndex]?.earliestArrival;
  return at ? new Date(at) : null;
}

/**
 * The latest start that still reaches the Termin with breaks, rests and the 30-minute buffer. Later starts never arrive
 * earlier with a fresh day anchored at the start, so a binary search to 5 minutes is exact enough; it makes no routing calls.
 */
export function latestStartForTermin(stops: PlannerStop[], targetIndex: number, appointmentAt: Date, earliest: Date, vehicle: PlanVehicle, times: WebfleetDrivingTimes | null):
  { status: 'OK'; latestStart: Date } | { status: 'TOO_LATE'; arrival: Date } | { status: 'UNKNOWN' } {
  const deadline = new Date(appointmentAt.getTime() - TERMIN_BUFFER_MINUTES * 60_000);
  const first = arrivalFrom(stops, targetIndex, earliest, vehicle, times);
  if (!first) return { status: 'UNKNOWN' };
  if (first > deadline) return { status: 'TOO_LATE', arrival: first };
  // Search on a 5-minute grid between the earliest start and the deadline: the answer is a time a dispatcher can say.
  const STEP = 5 * 60_000;
  const grid0 = Math.ceil(earliest.getTime() / STEP) * STEP;
  const steps = Math.floor((deadline.getTime() - grid0) / STEP);
  const fits = (k: number) => { const arrival = arrivalFrom(stops, targetIndex, new Date(grid0 + k * STEP), vehicle, times); return Boolean(arrival && arrival <= deadline); };
  if (steps < 0 || !fits(0)) return { status: 'OK', latestStart: earliest };
  let lo = 0, hi = steps;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  return { status: 'OK', latestStart: new Date(grid0 + lo * STEP) };
}

/** Today's start: the real one from the tachograph, otherwise an estimate for the Termin, after the rest or at 06:00. */
export function estimateStart(input: { now: Date; dayKey: string; hours: DriverHours; stops: PlannerStop[]; vehicle: PlanVehicle }): StartEstimate {
  const { now, hours, stops, vehicle } = input;
  const times = hours.times;
  const activity = hours.status === 'SIGNED_ON' ? stopActivityOf({ workState: hours.workState, activitySince: hours.activitySince, times, now }) : null;
  if (hours.status === 'SIGNED_ON' && times?.shiftStartedAt && activity?.kind !== 'DAILY_REST') {
    const started = new Date(times.shiftStartedAt);
    if (started.getTime() <= now.getTime() && now.getTime() - started.getTime() <= TACHO_SHIFT_MAX_AGE_MS) return { at: started, kind: 'TACHO' };
  }
  const restEnd = times?.earliestNextShiftAt ? new Date(times.earliestNextShiftAt) : null;
  const base = restEnd ?? berlinLocalToDate(`${input.dayKey}T${DEFAULT_START_LOCAL_TIME}`)!;
  const earliest = new Date(Math.max(base.getTime(), now.getTime()));
  const kind: StartKind = restEnd ? 'AFTER_REST' : 'DEFAULT';
  const target = stops.findIndex((stop) => stop.appointmentAt && !stop.arrivedAt && Date.parse(stop.appointmentAt) <= now.getTime() + TERMIN_HORIZON_MS);
  if (target >= 0) {
    const result = latestStartForTermin(stops, target, new Date(stops[target].appointmentAt!), earliest, vehicle, times);
    if (result.status === 'OK') return { at: result.latestStart, kind: 'TERMIN_LATEST', terminFeasible: true };
    if (result.status === 'TOO_LATE') return { at: earliest, kind, terminFeasible: false, arrivalFromEarliest: result.arrival };
  }
  return { at: earliest, kind };
}

type StopLite = {
  id: string; type: string; city: string | null; address: string; arrivedAt: Date | null; completedAt: Date | null; appointmentAt: Date | null;
  sequence?: number; instructions?: string | null;
};
type TourLite = { id: string; status: string; trailerPlate: string | null; tourRemarks?: string | null; stops: StopLite[] };
export type StatusInput = {
  dayKey: string; dayStart: Date;
  vehicle: { id: string; vehicleNumber: string; statusGroup: string | null; servicePhone: string | null; aSchild: boolean; appSped: boolean; currentTrailerPlate: string | null };
  tours: TourLite[];
  place: { city: string | null; source: 'WEBFLEET' | 'WEBFLEET_STALE' | 'NONE' };
  start: StartEstimate;
  /** Expected arrival at the next stop; null when unknown. */
  nextEta: Date | null;
  coupledTrailerNo: string | null;
  flags?: StatusFlag[];
};
export type StatusRowDraft = {
  vehicleId: string; vehicleNumber: string; statusGroup: string | null; rule: StatusRule;
  ort: string | null; ortSource: string | null; startAt: Date | null; startKind: StartKind;
  ziel: string | null; ankunftAt: Date | null; ankunftKind: AnkunftKind; bemerkungAuto: string | null;
  trailer: string | null; trailerSource: string | null; servicePhone: string | null; aSchild: boolean; appSped: boolean;
  tourId: string | null; stopId: string | null; flags: StatusFlag[];
};

const stopCity = (stop: StopLite) => stop.city ?? cityOf(stop.address) ?? stop.address;

/**
 * One truck's line in the status list. Rules in order: did not finish loading or unloading yesterday; empty without a next
 * tour; standing at a stop since today; otherwise on the way (or not started yet) to the next stop.
 */
export function buildStatusRow(input: StatusInput): StatusRowDraft {
  const { vehicle, dayKey, dayStart } = input;
  const flags = new Set<StatusFlag>(input.flags ?? []);
  const tours = [...input.tours].sort((a, b) => Number(a.status !== 'ACTIVE') - Number(b.status !== 'ACTIVE'));
  const active = tours.find((tour) => tour.status === 'ACTIVE') ?? null;
  const queued = tours.find((tour) => tour.status === 'QUEUED') ?? null;
  const current = active?.stops.find((stop) => !stop.completedAt) ?? null;
  const next = current ?? queued?.stops.find((stop) => !stop.completedAt) ?? null;
  const trailerPlate = active?.trailerPlate ?? queued?.trailerPlate ?? null;
  const trailer = trailerPlate ? { trailer: trailerPlate, trailerSource: 'TOUR' }
    : vehicle.currentTrailerPlate ? { trailer: vehicle.currentTrailerPlate, trailerSource: 'VEHICLE' }
      : input.coupledTrailerNo ? { trailer: input.coupledTrailerNo, trailerSource: 'WEBFLEET_COUPLING' } : { trailer: null, trailerSource: null };
  const base = { vehicleId: vehicle.id, vehicleNumber: vehicle.vehicleNumber, statusGroup: vehicle.statusGroup, servicePhone: vehicle.servicePhone,
    aSchild: vehicle.aSchild, appSped: vehicle.appSped, ...trailer };
  const place = { ort: input.place.city, ortSource: input.place.source };
  if (input.place.source === 'WEBFLEET_STALE') flags.add('GPS_STALE');

  if (current?.arrivedAt && current.arrivedAt < dayStart) {
    const yesterday = current.arrivedAt >= dayStartOf(previousDayKey(dayKey));
    const unload = current.type === 'UNLOAD';
    const since = BERLIN_DATE.format(current.arrivedAt);
    return { ...base, rule: 'STUCK', ort: stopCity(current), ortSource: 'STOP', startAt: input.start.at, startKind: input.start.kind,
      ziel: stopCity(current), ankunftAt: current.arrivedAt, ankunftKind: 'ARRIVED',
      bemerkungAuto: withZuladungNote(yesterday ? (unload ? STATUS_TEXT_DE.STUCK_UNLOAD_YESTERDAY : STATUS_TEXT_DE.STUCK_LOAD_YESTERDAY) : (unload ? STATUS_TEXT_DE.STUCK_UNLOAD_SINCE(since) : STATUS_TEXT_DE.STUCK_LOAD_SINCE(since)), active),
      tourId: active?.id ?? null, stopId: current.id, flags: [...flags] };
  }
  if (!active && !queued) {
    if (!place.ort) flags.add('NO_GPS');
    return { ...base, ...place, rule: 'EMPTY', startAt: null, startKind: 'NONE', ziel: null, ankunftAt: null, ankunftKind: 'NONE',
      bemerkungAuto: STATUS_TEXT_DE.EMPTY, tourId: null, stopId: null, flags: [...flags] };
  }
  if (current?.arrivedAt) {
    return { ...base, rule: 'AT_STOP', ort: stopCity(current), ortSource: 'STOP', startAt: input.start.at, startKind: input.start.kind,
      ziel: stopCity(current), ankunftAt: current.arrivedAt, ankunftKind: 'ARRIVED',
      bemerkungAuto: withZuladungNote(current.type === 'UNLOAD' ? STATUS_TEXT_DE.AT_UNLOAD : STATUS_TEXT_DE.AT_LOAD, active), tourId: active?.id ?? null, stopId: current.id, flags: [...flags] };
  }
  if (!place.ort) flags.add('NO_GPS');
  const termin = next?.appointmentAt ?? null;
  const eta = input.nextEta;
  let bemerkungAuto: string | null = null;
  const lateEta = termin && eta && eta > termin ? eta : termin && input.start.terminFeasible === false ? input.start.arrivalFromEarliest ?? null : null;
  if (termin && lateEta) {
    flags.add('TERMIN_AT_RISK');
    bemerkungAuto = STATUS_TEXT_DE.TERMIN_AT_RISK(statusTime(lateEta, dayKey), statusTime(termin, dayKey));
  }
  return { ...base, ...place, rule: 'EN_ROUTE', startAt: input.start.at, startKind: input.start.kind,
    ziel: next ? stopCity(next) : null, ankunftAt: termin ?? eta, ankunftKind: termin ? 'TERMIN' : eta ? 'ETA' : 'NONE',
    bemerkungAuto: withZuladungNote(bemerkungAuto, current ? active : queued), tourId: (current ? active?.id : queued?.id) ?? null, stopId: next?.id ?? null, flags: [...flags] };
}

/** Values as shown on the page and in Excel: estimates carry "~", a Termin and a real arrival do not. */
export type StatusOverrides = Partial<Record<'ort' | 'start' | 'ziel' | 'ankunft' | 'trailer', string | null>>;
export function presentRow(row: {
  ort: string | null; startAt: Date | null; startKind: string; ziel: string | null; ankunftAt: Date | null; ankunftKind: string;
  bemerkungAuto: string | null; bemerkung: string | null; trailer: string | null; overridesJson: string | null;
}, dayKey: string) {
  let overrides: StatusOverrides = {};
  try { overrides = row.overridesJson ? JSON.parse(row.overridesJson) as StatusOverrides : {}; } catch { overrides = {}; }
  const start = row.startAt ? `${row.startKind === 'TACHO' ? '' : '~'}${statusTime(row.startAt, dayKey)}` : '';
  const ankunft = row.ankunftAt ? `${row.ankunftKind === 'ETA' ? '~' : ''}${statusTime(row.ankunftAt, dayKey)}` : '';
  const pick = (key: keyof StatusOverrides, auto: string) => overrides[key] !== undefined && overrides[key] !== null ? String(overrides[key]) : auto;
  return {
    ort: pick('ort', row.ort ?? ''), start: pick('start', start), ziel: pick('ziel', row.ziel ?? ''), ankunft: pick('ankunft', ankunft),
    bemerkung: row.bemerkung ?? row.bemerkungAuto ?? '', trailer: pick('trailer', row.trailer ?? '')
  };
}

export type DailyStatusDeps = {
  getPosition(vehicleId: string, now: Date): Promise<CurrentPosition>;
  latestTelemetry(vehicleId: string, now: Date): Promise<{ address: string | null; stale: boolean } | null>;
  driverHours(vehicleId: string, now: Date): Promise<DriverHours>;
  coupledTrailerNo(vehicleId: string): Promise<string | null>;
  webfleetReady(now: Date): boolean;
  eta: EtaService;
  startedAt: Date;
};
export type RunResult = 'NOT_DUE' | 'DONE' | 'BUSY' | 'WAITING_WEBFLEET' | 'GENERATED' | 'FAILED';
export const DAILY_STATUS_SYSTEM_ACTOR: AuditActor = { role: 'system', sessionId: 'daily-status' };

export class DailyStatusError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}

/** Builds, stores and serves the daily status list of each customer that has one (Schnellecke at 07:00). Webfleet is only read. */
export class DailyStatusService {
  private running = false;
  private listsCache: { at: number; lists: StatusListConfig[] } | null = null;
  constructor(private readonly db: PrismaClient, private readonly deps: DailyStatusDeps) {}

  /**
   * Every customer with a status list in its profile, blocks = its lines. Before customers exist, or while
   * Schnellecke is not yet a customer, the original Schnellecke list keeps running.
   */
  async lists(): Promise<StatusListConfig[]> {
    if (this.listsCache && Date.now() - this.listsCache.at < 60_000) return this.listsCache.lists;
    const customers = await this.db.customer.findMany({ where: { active: true }, orderBy: { name: 'asc' },
      include: { lines: { where: { active: true }, orderBy: [{ sortIndex: 'asc' }, { name: 'asc' }] } } }).catch(() => []);
    const lists: StatusListConfig[] = customers.flatMap((customer) => {
      const profile = parseProfile(customer.profileJson).statusList;
      if (!profile.enabled) return [];
      return [{ key: customer.slug, customerId: customer.id, name: customer.name, dueLocalTime: profile.dueLocalTime,
        groups: customer.lines.map((line) => ({ code: line.code, name: line.name })), excludedVehicles: profile.excludedVehicles,
        columns: { we: profile.weColumnLabel, aSchild: profile.showASchild, appSped: profile.showAppSped } }];
    });
    if (!customers.some((customer) => customer.slug === STATUS_LINE)) lists.unshift(LEGACY_STATUS_LIST);
    this.listsCache = { at: Date.now(), lists };
    return lists;
  }

  async list(key?: string | null): Promise<StatusListConfig> {
    const lists = await this.lists();
    const found = key ? lists.find((item) => item.key === key) : lists[0];
    if (!found) throw new DailyStatusError('Такого списка статуса нет.', 404);
    return found;
  }

  /** Runs every list that is due; the result of the most eventful one is returned. */
  async runIfDue(now = new Date()): Promise<RunResult> {
    const order: RunResult[] = ['GENERATED', 'FAILED', 'BUSY', 'WAITING_WEBFLEET', 'DONE', 'NOT_DUE'];
    let best: RunResult = 'NOT_DUE';
    for (const list of await this.lists()) {
      const result = await this.runListIfDue(list, now);
      if (order.indexOf(result) < order.indexOf(best)) best = result;
    }
    return best;
  }

  private async runListIfDue(list: StatusListConfig, now: Date): Promise<RunResult> {
    if (this.running) return 'BUSY';
    const dayKey = berlinToday(now);
    const due = berlinLocalToDate(`${dayKey}T${list.dueLocalTime}`)!;
    if (now < due) return 'NOT_DUE';
    const existing = await this.db.dailyStatusReport.findUnique({ where: { line_date: { line: list.key, date: dayKey } } });
    if (existing?.status === 'READY') return 'DONE';
    if (existing?.status === 'GENERATING' && now.getTime() - existing.updatedAt.getTime() < STALE_GENERATION_MS) return 'BUSY';
    const graceEnd = Math.max(due.getTime(), this.deps.startedAt.getTime()) + WEBFLEET_GRACE_MS;
    if (!this.deps.webfleetReady(now) && now.getTime() < graceEnd) return 'WAITING_WEBFLEET';
    // The unique (line, date) is the lock: only one instance or tick claims the list.
    if (existing) {
      const claimed = await this.db.dailyStatusReport.updateMany({ where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt }, data: { status: 'GENERATING' } });
      if (!claimed.count) return 'BUSY';
    } else {
      try { await this.db.dailyStatusReport.create({ data: { line: list.key, customerId: list.customerId, date: dayKey, status: 'GENERATING', generatedByRole: 'system' } }); }
      catch { return 'BUSY'; }
    }
    this.running = true;
    try {
      await this.generate(dayKey, now, DAILY_STATUS_SYSTEM_ACTOR, { claimed: true, list: list.key });
      return 'GENERATED';
    } catch {
      await this.db.dailyStatusReport.updateMany({ where: { line: list.key, date: dayKey }, data: { status: 'FAILED' } }).catch(() => undefined);
      return 'FAILED';
    } finally { this.running = false; }
  }

  async generate(dayKey: string, now: Date, actor: AuditActor, options: { resetEdits?: boolean; claimed?: boolean; list?: string | null } = {}) {
    if (dayKey !== berlinToday(now)) throw new DailyStatusError('Прошлые списки только для чтения.', 409);
    const list = await this.list(options.list);
    const report = options.claimed
      ? await this.db.dailyStatusReport.findUniqueOrThrow({ where: { line_date: { line: list.key, date: dayKey } } })
      : await this.db.dailyStatusReport.upsert({ where: { line_date: { line: list.key, date: dayKey } },
        create: { line: list.key, customerId: list.customerId, date: dayKey, status: 'GENERATING', generatedByRole: actor.role }, update: { status: 'GENERATING' } });
    const vehicles = await this.db.vehicle.findMany({ where: { line: list.key, ...(list.excludedVehicles.length ? { vehicleNumber: { notIn: list.excludedVehicles } } : {}) }, include: {
      issues: { where: { resolvedAt: null } },
      tours: { where: { status: { in: ['ACTIVE', 'QUEUED'] } }, orderBy: [{ queueIndex: 'asc' }, { createdAt: 'asc' }], include: { stops: { orderBy: { sequence: 'asc' } }, legs: true } }
    } });
    const dayStart = dayStartOf(dayKey);
    const ready = this.deps.webfleetReady(now);
    const drafts: StatusRowDraft[] = [];
    for (const vehicle of vehicles) drafts.push(await this.rowFor(vehicle, dayKey, dayStart, now, ready));
    const groupOrder = list.groups.map((group) => group.code);
    const order = (draft: StatusRowDraft) => {
      const group = groupOrder.indexOf(draft.statusGroup ?? '');
      return [group < 0 ? groupOrder.length : group, Number.parseInt(draft.vehicleNumber, 10) || Number.MAX_SAFE_INTEGER, draft.vehicleNumber] as const;
    };
    drafts.sort((a, b) => { const [ga, na, sa] = order(a), [gb, nb, sb] = order(b); return ga - gb || na - nb || sa.localeCompare(sb); });
    const keep = new Set(drafts.map((draft) => draft.vehicleId));
    const removed = await this.db.dailyStatusRow.findMany({ where: { reportId: report.id, vehicleId: { notIn: [...keep] } }, select: { id: true, vehicleNumber: true } });
    await this.db.$transaction(async (tx) => {
      for (const [index, draft] of drafts.entries()) {
        const { flags, ...fields } = draft;
        const data = { ...fields, sortIndex: index, detailsJson: JSON.stringify({ flags }) };
        await tx.dailyStatusRow.upsert({ where: { reportId_vehicleId: { reportId: report.id, vehicleId: draft.vehicleId } },
          create: { ...data, reportId: report.id },
          update: { ...data, ...(options.resetEdits ? { bemerkung: null, weNortheim: null, overridesJson: null, editedAt: null, editedByDispatcherId: null } : {}), version: { increment: 1 } } });
      }
      if (removed.length) await tx.dailyStatusRow.deleteMany({ where: { id: { in: removed.map((row) => row.id) } } });
      await tx.dailyStatusReport.update({ where: { id: report.id }, data: { status: 'READY', preliminary: !ready || drafts.some((draft) => draft.flags.includes('PRELIMINARY')),
        generatedAt: now, generatedByRole: actor.role, generatedByDispatcherId: actor.dispatcherId ?? null } });
    });
    await writeAuditLog(this.db, actor, { action: 'DAILY_STATUS_GENERATED', entityType: 'DailyStatusReport', entityId: report.id,
      metadata: { line: list.key, date: dayKey, rows: drafts.length, preliminary: !ready, resetEdits: Boolean(options.resetEdits), removed: removed.map((row) => row.vehicleNumber) } });
    return this.get(dayKey, now, list.key);
  }

  private async rowFor(vehicle: Awaited<ReturnType<PrismaClient['vehicle']['findMany']>>[number] & { tours: Array<Parameters<typeof buildPlannerStops>[0]['tours'][number]>; issues: Array<{ kind: string; resolvedAt: Date | null; expectedResolvedAt: Date | null }> },
    dayKey: string, dayStart: Date, now: Date, ready: boolean): Promise<StatusRowDraft> {
    const flags = new Set<StatusFlag>();
    if (!ready) flags.add('PRELIMINARY');
    const [position, telemetry, hours, coupled] = await Promise.all([
      this.deps.getPosition(vehicle.id, now), this.deps.latestTelemetry(vehicle.id, now).catch(() => null),
      this.deps.driverHours(vehicle.id, now), this.deps.coupledTrailerNo(vehicle.id).catch(() => null)
    ]);
    if (hours.status === 'NO_WEBFLEET') flags.add('NO_WEBFLEET');
    if (!hours.times) flags.add('TACHO_MISSING');
    const tours = [...vehicle.tours].sort((a, b) => Number(a.status !== 'ACTIVE') - Number(b.status !== 'ACTIVE'));
    const active = tours.find((tour) => tour.status === 'ACTIVE');
    const currentStop = active?.stops.find((stop) => !stop.completedAt);
    const activeLeg = active?.legs.find((leg) => ['ACTIVE', 'ARRIVED'].includes(leg.status) && leg.toStopId === currentStop?.id && !currentStop?.arrivedAt) ?? null;
    const snapshot = snapshotVehicleClock(vehicle, activeLeg, now);
    const offline: DriveEstimate = async (from, to, _label, _departure, approach) => {
      if (approach !== null) return approach;
      if (!from) return null;
      flags.add('ROUTE_ESTIMATE');
      return distanceMeters(from.latitude, from.longitude, to.latitude, to.longitude) * ROAD_FACTOR / (Math.min(vehicle.maxSpeedKmh, OFFLINE_SPEED_KMH) / 3.6);
    };
    const { stops } = await buildPlannerStops({ tours, activeLeg, position, driveElapsedSeconds: snapshot.driveElapsedSeconds, startAt: now, estimate: offline });
    const planVehicle = { id: vehicle.id, vehicleNumber: vehicle.vehicleNumber, licensePlate: vehicle.licensePlate };
    const start = tours.length ? estimateStart({ now, dayKey, hours, stops, vehicle: planVehicle }) : { at: null, kind: 'NONE' as const };
    const nextEta = stops.length && !stops[0].arrivedAt ? this.etaToNext(stops, start, hours, now, planVehicle, snapshot.clockState, vehicle, tours) : null;
    const address = telemetry?.address ?? null;
    const place = position.positionSource === 'WEBFLEET' || address
      ? { city: cityOf(address) ?? (position.positionSource === 'MANUAL' ? cityOf(vehicle.manualPositionAddress) : null), source: telemetry?.stale ? 'WEBFLEET_STALE' as const : address ? 'WEBFLEET' as const : 'NONE' as const }
      : { city: position.positionSource === 'MANUAL' ? cityOf(vehicle.manualPositionAddress) : null, source: 'NONE' as const };
    return buildStatusRow({ dayKey, dayStart,
      vehicle: { id: vehicle.id, vehicleNumber: vehicle.vehicleNumber, statusGroup: vehicle.statusGroup, servicePhone: vehicle.servicePhone, aSchild: vehicle.aSchild, appSped: vehicle.appSped, currentTrailerPlate: vehicle.currentTrailerPlate },
      tours: tours.map((tour) => ({ id: tour.id, status: tour.status, trailerPlate: tour.trailerPlate, tourRemarks: tour.tourRemarks, stops: tour.stops })),
      place, start, nextEta, coupledTrailerNo: coupled, flags: [...flags] });
  }

  /** The expected arrival at the next stop: from the real tachograph when the driver is working, else from the estimated start. */
  private etaToNext(stops: PlannerStop[], start: StartEstimate, hours: DriverHours, now: Date, vehicle: PlanVehicle,
    clock: ReturnType<typeof snapshotVehicleClock>['clockState'], row: { clockState: string | null; manualStoppedAt: Date | null; issues: Array<{ kind: string; resolvedAt: Date | null; expectedResolvedAt: Date | null }> },
    tours: Array<Parameters<EtaService['calculateVehicleSchedule']>[0][number]>): Date | null {
    let plan;
    if (start.kind === 'TACHO') {
      const budget = hours.times ? driverBudgetFromWebfleet(hours.times, { workState: hours.workState, since: hours.activitySince }, now) : null;
      plan = planTermin({ now, startAt: now, stops, targetIndex: 0, driver: budget, clock: budget ? null : clock, vehicle, start: PLAN_START });
    } else if (start.at) {
      plan = planTermin({ now, startAt: start.at, stops, targetIndex: 0, driver: freshDayBudget(start.at, hours.times), clock: null, vehicle, start: PLAN_START });
    }
    const at = plan?.stops[0]?.earliestArrival;
    if (at) return new Date(at);
    const schedule = this.deps.eta.calculateVehicleSchedule(tours.map((tour) => ({ ...tour, vehicle: row })), now);
    return schedule.find((item) => item.stopId === stops[0]?.stopId)?.predictedEta ?? null;
  }

  async get(dayKey: string, now = new Date(), key?: string | null) {
    const list = await this.list(key);
    const lists = (await this.lists()).map((item) => ({ key: item.key, name: item.name }));
    const config = { key: list.key, name: list.name, dueLocalTime: list.dueLocalTime, groups: list.groups, columns: list.columns };
    const report = await this.db.dailyStatusReport.findUnique({ where: { line_date: { line: list.key, date: dayKey } }, include: { rows: { orderBy: { sortIndex: 'asc' } } } });
    if (!report) return { date: dayKey, list: config, lists, report: null, rows: [], editable: dayKey === berlinToday(now) };
    const { rows, ...meta } = report;
    return { date: dayKey, list: config, lists, editable: dayKey === berlinToday(now) && report.status === 'READY', report: meta,
      rows: rows.map((row) => ({ ...row, flags: flagsOf(row.detailsJson), shown: presentRow(row, dayKey), edited: Boolean(row.editedAt) })) };
  }

  async editRow(id: string, input: { version: number; bemerkung?: string | null; weNortheim?: string | null; overrides?: StatusOverrides }, actor: AuditActor, now = new Date()) {
    const row = await this.db.dailyStatusRow.findUnique({ where: { id }, include: { report: true } });
    if (!row) throw new DailyStatusError('Строка не найдена.', 404);
    if (row.report.date !== berlinToday(now)) throw new DailyStatusError('Прошлые списки только для чтения.', 409);
    let overrides: StatusOverrides = {};
    try { overrides = row.overridesJson ? JSON.parse(row.overridesJson) as StatusOverrides : {}; } catch { overrides = {}; }
    if (input.overrides) for (const [key, value] of Object.entries(input.overrides)) {
      if (value === null) delete overrides[key as keyof StatusOverrides]; else overrides[key as keyof StatusOverrides] = value;
    }
    const data = {
      ...(input.bemerkung !== undefined ? { bemerkung: input.bemerkung } : {}),
      ...(input.weNortheim !== undefined ? { weNortheim: input.weNortheim } : {}),
      ...(input.overrides ? { overridesJson: Object.keys(overrides).length ? JSON.stringify(overrides) : null } : {}),
      editedAt: now, editedByDispatcherId: actor.dispatcherId ?? null, version: { increment: 1 }
    };
    const changed = await this.db.dailyStatusRow.updateMany({ where: { id, version: input.version }, data });
    if (!changed.count) throw new DailyStatusError('Строку только что изменил другой диспетчер. Список обновлён — проверьте и повторите.', 409);
    await writeAuditLog(this.db, actor, { action: 'DAILY_STATUS_ROW_EDITED', entityType: 'DailyStatusRow', entityId: id, vehicleId: row.vehicleId,
      metadata: { date: row.report.date, vehicleNumber: row.vehicleNumber, fields: Object.keys(input).filter((key) => key !== 'version') } });
    const updated = await this.db.dailyStatusRow.findUniqueOrThrow({ where: { id } });
    return { ...updated, flags: flagsOf(updated.detailsJson), shown: presentRow(updated, row.report.date), edited: true };
  }
}

function flagsOf(details: string | null): StatusFlag[] {
  try { return details ? (JSON.parse(details) as { flags?: StatusFlag[] }).flags ?? [] : []; } catch { return []; }
}
