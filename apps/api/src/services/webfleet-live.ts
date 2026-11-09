import type { PrismaClient } from '@prisma/client';
import { driverBudgetAfterRest, driverBudgetFromWebfleet, type DriverEtaInput } from './termin-planner.js';
import {
  normalizePlate, readWebfleetConfig, webfleetRequest, WebfleetError,
  type WebfleetConfig, type WebfleetDriverOnObject, type WebfleetErrorCategory, type WebfleetPosition, type WebfleetReadAction
} from './webfleet.js';

const PROVIDER = 'WEBFLEET';
const MINUTE = 60_000;
/** Extra reports run only right after a successful position snapshot, so wrong credentials cost one login, not several. */
const CREDENTIALS_PROVEN_MS = 3 * MINUTE;
const DRIVER_LIVE_MS = 5 * MINUTE;
/** A card taken out in the evening still tells at 07:00 when the next shift may start. */
const LAST_DRIVER_MS = 20 * 60 * MINUTE;
/** Event and trip reports allow 1 request/minute per account; keep a safety margin between any two of them. */
export const SLOW_REPORT_GAP_MS = 65_000;
const TRACK_CACHE_MS = 2 * MINUTE;
const TRACKS_PER_MINUTE = 5;
const TRACK_MAX_POINTS = 2000;
const ERROR_DELAY_MS: Record<WebfleetErrorCategory, number> = {
  AUTH: 30 * MINUTE, PERMISSION: 30 * MINUTE, CONFIG: 30 * MINUTE,
  RATE_LIMIT: 5 * MINUTE, NETWORK: 5 * MINUTE, INVALID_RESPONSE: 5 * MINUTE, UNKNOWN: 5 * MINUTE
};

export type WebfleetDrivingTimes = {
  driverUid: string;
  name: string | null;
  referenceTime: string | null;
  remainDrivingTodayMs: number | null;
  totalDrivingTodayMs: number | null;
  totalOtherWorkTodayMs: number | null;
  totalAvailabilityTodayMs: number | null;
  maxDrivingTodayMs: number | null;
  remainDrivingWeekMs: number | null;
  maxDrivingWeekMs: number | null;
  shiftStartedAt: string | null;
  latestShiftEndAt: string | null;
  /** Latest start of the next break / rest as a clock time: reference time plus the remaining milliseconds. */
  nextBreakAt: string | null;
  nextBreakMinMs: number | null;
  nextRestAt: string | null;
  nextRestMinMs: number | null;
  earliestNextShiftAt: string | null;
  /** Used this week. Checked against the Webfleet screen: 0 used of 2 shows two available 10 h days. */
  extendedShiftsUsed: number | null;
  maxExtendedShifts: number | null;
  reducedRestsUsed: number | null;
  maxReducedRests: number | null;
  restBalances: Array<{ until: string; ms: number }>;
  infringements: boolean;
  lastCardActivityAt: string | null;
};

export type WebfleetDriverActivity = { driverUid: string; workState: number | null; since: string | null };
export type WebfleetVehicleInfo = { objectUid: string; plate: string | null; vin: string | null; tankLiters: number | null };
export type WebfleetCoupling = { vehicleUid: string; assetUid: string; coupledAt: string | null };
export type WebfleetEvent = { id: string; objectUid: string | null; objectNo: string | null; at: string; level: 'INFO' | 'WARNING' | 'ALARM'; text: string; address: string | null; resolved: boolean };
export type WebfleetTrip = { id: string; objectUid: string | null; objectNo: string | null; startAt: string; endAt: string | null; startAddress: string | null; endAddress: string | null; distanceKm: number | null; businessTrip: boolean };
export type WebfleetMaintenance = { objectUid: string | null; objectNo: string | null; name: string; description: string | null; dueAt: string | null; dueOdometerKm: number | null };

type FeedState = { at: number; nextAt: number; error: WebfleetErrorCategory | null; providerCode: number | null };
const feed = (): FeedState => ({ at: 0, nextAt: 0, error: null, providerCode: null });
type ObjectFacts = { objectNo: string | null; licensePlate: string | null; isTrailer: boolean; driver: WebfleetDriverOnObject | null };

/**
 * Latest Webfleet facts kept in server memory. Driver names, driving times, OptiDrive, trips and events live only here:
 * they are never written to the database, history or logs (DSGVO), and refill within minutes after a restart.
 */
export class WebfleetLiveStore {
  private objects = new Map<string, ObjectFacts>();
  private lastDrivers = new Map<string, { driverUid: string; seenAt: number }>();
  private drivers = new Map<string, WebfleetDrivingTimes>();
  private activities = new Map<string, WebfleetDriverActivity>();
  private optiDrive = new Map<string, number>();
  private vehicles = new Map<string, WebfleetVehicleInfo>();
  private couplings = new Map<string, WebfleetCoupling>();
  private events = new Map<string, WebfleetEvent[]>();
  private trips = new Map<string, WebfleetTrip[]>();
  private maintenance = new Map<string, WebfleetMaintenance[]>();
  objectsAt = 0;
  readonly drivingFeed = feed();
  readonly vehicleFeed = feed();
  readonly couplingFeed = feed();
  readonly eventFeed = feed();
  readonly tripFeed = feed();
  readonly optiDriveFeed = feed();
  readonly maintenanceFeed = feed();

  setObjects(positions: WebfleetPosition[], now: Date) {
    this.objects = new Map(positions.map((position) => [position.objectUid, {
      objectNo: position.objectNo ?? null, licensePlate: position.licensePlate ?? null, isTrailer: position.isTrailer === true, driver: position.driver ?? null
    }]));
    for (const position of positions) {
      if (position.driver?.driverUid) this.lastDrivers.set(position.objectUid, { driverUid: position.driver.driverUid, seenAt: now.getTime() });
    }
    for (const [objectUid, last] of this.lastDrivers) if (now.getTime() - last.seenAt > LAST_DRIVER_MS) this.lastDrivers.delete(objectUid);
    this.objectsAt = now.getTime();
  }

  /** The driver who last had the card in this truck, within 20 h: memory only, for "when may the next shift start". */
  lastDriverOn(objectUid: string, now: Date) {
    const last = this.lastDrivers.get(objectUid);
    return last && now.getTime() - last.seenAt <= LAST_DRIVER_MS ? last.driverUid : null;
  }

  setDrivingTimes(rows: WebfleetDrivingTimes[], activities: WebfleetDriverActivity[], now: Date) {
    this.drivers = new Map(rows.map((row) => [row.driverUid, row]));
    this.activities = new Map(activities.map((row) => [row.driverUid, row]));
    markOk(this.drivingFeed, now);
  }

  setVehicles(rows: WebfleetVehicleInfo[], now: Date) {
    this.vehicles = new Map(rows.map((row) => [row.objectUid, row]));
    markOk(this.vehicleFeed, now);
  }

  setCouplings(rows: WebfleetCoupling[], now: Date) {
    this.couplings = new Map(rows.map((row) => [row.vehicleUid, row]));
    markOk(this.couplingFeed, now);
  }

  setEvents(rows: WebfleetEvent[], now: Date) {
    this.events = groupBy(rows, (row) => row.objectUid ?? row.objectNo, (a, b) => b.at.localeCompare(a.at));
    markOk(this.eventFeed, now);
  }

  setTrips(rows: WebfleetTrip[], now: Date) {
    this.trips = groupBy(rows, (row) => row.objectUid ?? row.objectNo, (a, b) => b.startAt.localeCompare(a.startAt));
    markOk(this.tripFeed, now);
  }

  setOptiDrive(rows: Array<{ driverUid: string; indicator: number }>, now: Date) {
    this.optiDrive = new Map(rows.map((row) => [row.driverUid, row.indicator]));
    markOk(this.optiDriveFeed, now);
  }

  setMaintenance(rows: WebfleetMaintenance[], now: Date) {
    this.maintenance = groupBy(rows, (row) => row.objectUid ?? row.objectNo, (a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
    markOk(this.maintenanceFeed, now);
  }

  driverOn(objectUid: string, now: Date) {
    if (!this.objectsAt || now.getTime() - this.objectsAt > DRIVER_LIVE_MS) return undefined;
    return this.objects.get(objectUid)?.driver ?? null;
  }

  /** All objects of the last report, including trucks whose position is too old to be stored. */
  allObjects() {
    return [...this.objects].map(([objectUid, object]) => ({ objectUid, objectNo: object.objectNo, licensePlate: object.licensePlate, isTrailer: object.isTrailer }));
  }

  objectNo(objectUid: string) { return this.objects.get(objectUid)?.objectNo ?? null; }
  drivingTimes(driverUid: string) { return this.drivers.get(driverUid) ?? null; }
  activity(driverUid: string) { return this.activities.get(driverUid) ?? null; }
  optiDriveScore(driverUid: string) { return this.optiDrive.get(driverUid) ?? null; }
  vehicleInfo(objectUid: string) { return this.vehicles.get(objectUid) ?? null; }
  coupling(objectUid: string) { return this.couplings.get(objectUid) ?? null; }
  eventsFor(objectUid: string, objectNo: string | null) { return this.events.get(objectUid) ?? (objectNo ? this.events.get(objectNo) : undefined) ?? []; }
  tripsFor(objectUid: string, objectNo: string | null) { return this.trips.get(objectUid) ?? (objectNo ? this.trips.get(objectNo) : undefined) ?? []; }
  maintenanceFor(objectUid: string, objectNo: string | null) { return this.maintenance.get(objectUid) ?? (objectNo ? this.maintenance.get(objectNo) : undefined) ?? []; }
}

type Request = (config: WebfleetConfig, action: WebfleetReadAction, params?: Record<string, string>) => Promise<unknown[]>;

/** Reads the extra reporting actions on their own schedules. Every action here is read-only. */
export class WebfleetDetailsSync {
  private running = false;
  private lastSlowAt = 0;

  constructor(
    private readonly store: WebfleetLiveStore,
    private readonly config: WebfleetConfig | null = readWebfleetConfig(),
    private readonly request: Request = (config, action, params) => webfleetRequest(config, action, params)
  ) {}

  async refreshIfDue(now = new Date()) {
    if (!this.config || this.running) return;
    if (!this.store.objectsAt || now.getTime() - this.store.objectsAt > CREDENTIALS_PROVEN_MS) return;
    this.running = true;
    const store = this.store;
    try {
      await this.refresh(store.drivingFeed, 5 * MINUTE, now, async () => {
        const [times, drivers] = await Promise.all([this.call('getRemainingDrivingTimesEU'), this.call('showDriverReportExtern')]);
        store.setDrivingTimes(compact(times.map(parseDrivingTimesRow)), compact(drivers.map(parseDriverActivityRow)), now);
      });
      await this.refresh(store.couplingFeed, 5 * MINUTE, now, async () => store.setCouplings(compact((await this.call('getActiveAssetCouplings')).map(parseCouplingRow)), now));
      await this.refresh(store.vehicleFeed, 60 * MINUTE, now, async () => store.setVehicles(compact((await this.call('showVehicleReportExtern')).map(parseVehicleReportRow)), now));
      await this.refresh(store.optiDriveFeed, 60 * MINUTE, now, async () => {
        const params = { range_pattern: 'ud', rangefrom_string: isoDay(now, -6), rangeto_string: now.toISOString() };
        store.setOptiDrive(compact((await this.call('showOptiDriveIndicator', params)).map(parseOptiDriveRow)), now);
      });
      await this.refresh(store.maintenanceFeed, 60 * MINUTE, now, async () => store.setMaintenance(compact((await this.call('showMaintenanceSchedules')).map(parseMaintenanceRow)), now));
      // At most one of the 1-per-minute reports per run, whichever is due first.
      await this.refreshSlow(store.eventFeed, 5 * MINUTE, now, async () => store.setEvents(compact((await this.call('showEventReportExtern', { range_pattern: 'w0' })).map(parseEventRow)), now))
        || await this.refreshSlow(store.tripFeed, 10 * MINUTE, now, async () => {
          const params = { range_pattern: 'ud', rangefrom_string: isoDay(now, -1), rangeto_string: now.toISOString() };
          store.setTrips(compact((await this.call('showTripReportExtern', params)).map(parseTripRow)), now);
        });
    } finally {
      this.running = false;
    }
  }

  private call(action: WebfleetReadAction, params: Record<string, string> = {}) {
    return this.request(this.config!, action, params);
  }

  private async refreshSlow(state: FeedState, intervalMs: number, now: Date, load: () => Promise<void>) {
    if (now.getTime() < state.nextAt || now.getTime() - this.lastSlowAt < SLOW_REPORT_GAP_MS) return false;
    this.lastSlowAt = now.getTime();
    await this.refresh(state, intervalMs, now, load);
    return true;
  }

  private async refresh(state: FeedState, intervalMs: number, now: Date, load: () => Promise<void>) {
    if (now.getTime() < state.nextAt) return;
    try {
      await load();
      state.nextAt = now.getTime() + intervalMs;
    } catch (error) {
      const failure = error instanceof WebfleetError ? error : new WebfleetError('UNKNOWN');
      Object.assign(state, { error: failure.category, providerCode: failure.providerCode, nextAt: now.getTime() + ERROR_DELAY_MS[failure.category] });
    }
  }
}

/** Today's GPS track of one truck, on demand. Cached per truck and limited per server so a busy screen cannot exhaust Webfleet. */
export class WebfleetTrackService {
  private cache = new Map<string, { at: number; points: Array<[number, number]> }>();
  private calls: number[] = [];

  constructor(
    private readonly config: WebfleetConfig | null = readWebfleetConfig(),
    private readonly request: Request = (config, action, params) => webfleetRequest(config, action, params)
  ) {}

  async track(objectUid: string, now = new Date()) {
    const cached = this.cache.get(objectUid);
    if (cached && now.getTime() - cached.at < TRACK_CACHE_MS) return { checkedAt: new Date(cached.at).toISOString(), points: cached.points };
    if (!this.config) throw Object.assign(new Error('Webfleet не настроен.'), { statusCode: 503 });
    this.calls = this.calls.filter((at) => now.getTime() - at < MINUTE);
    if (this.calls.length >= TRACKS_PER_MINUTE) throw Object.assign(new Error('Трек запрашивали слишком часто. Повторите через минуту.'), { statusCode: 429 });
    this.calls.push(now.getTime());
    let rows: unknown[];
    try { rows = await this.request(this.config, 'showTracks', { objectuid: objectUid, range_pattern: 'd0' }); }
    catch { throw Object.assign(new Error('Webfleet не отдал трек. Повторите позже.'), { statusCode: 502 }); }
    const points = thin(compact(rows.map(parseTrackRow)).sort((a, b) => a.at - b.at).map((row) => row.coordinate), TRACK_MAX_POINTS);
    this.cache.set(objectUid, { at: now.getTime(), points });
    return { checkedAt: now.toISOString(), points };
  }
}

export function parseDrivingTimesRow(value: unknown): WebfleetDrivingTimes | null {
  if (!isRecord(value)) return null;
  const driverUid = str(value, 'driveruid');
  if (!driverUid) return null;
  const reference = iso(value, 'reference_time');
  const plus = (key: string) => {
    const ms = num(value, key);
    return reference && ms !== null ? new Date(Date.parse(reference) + ms).toISOString() : null;
  };
  return {
    driverUid,
    name: str(value, 'drivername')?.trim().slice(0, 80) || null,
    referenceTime: reference,
    remainDrivingTodayMs: num(value, 'remain_driving_today'),
    totalDrivingTodayMs: num(value, 'total_driving_today'),
    totalOtherWorkTodayMs: num(value, 'total_otherwork_today'),
    totalAvailabilityTodayMs: num(value, 'total_availability_today'),
    maxDrivingTodayMs: num(value, 'max_driving_today'),
    remainDrivingWeekMs: num(value, 'remain_driving_week'),
    maxDrivingWeekMs: num(value, 'max_driving_week'),
    shiftStartedAt: iso(value, 'current_shift_start'),
    latestShiftEndAt: iso(value, 'latest_end_current_shift'),
    nextBreakAt: plus('next_break'),
    nextBreakMinMs: num(value, 'next_break_min_duration'),
    nextRestAt: plus('next_rest'),
    nextRestMinMs: num(value, 'next_rest_min_duration'),
    earliestNextShiftAt: iso(value, 'earliest_start_next_shift'),
    extendedShiftsUsed: num(value, 'extended_shifts'),
    maxExtendedShifts: num(value, 'max_extended_shifts'),
    reducedRestsUsed: num(value, 'reduced_rests'),
    maxReducedRests: num(value, 'max_reduced_rests'),
    restBalances: parseRestBalances(str(value, 'rest_balances')),
    infringements: value.infringements === true || value.infringements === 'true',
    lastCardActivityAt: iso(value, 'last_activity_from_drivercard')
  };
}

/** "2026-11-15T04:06:00Z,35640000;…": reduced weekly rest that must be compensated until the date. */
function parseRestBalances(value: string | null) {
  if (!value) return [];
  return value.split(/[;|]/).flatMap((item) => {
    const [date, ms] = item.split(',');
    const until = new Date(date?.trim() ?? '');
    const amount = Number(ms);
    return Number.isNaN(until.getTime()) || !Number.isFinite(amount) ? [] : [{ until: until.toISOString(), ms: amount }];
  });
}

/** Start of the current tachograph activity. Checked against the Webfleet screen: "Fahrt seit 08:46" = current_workingtimeend. */
export function parseDriverActivityRow(value: unknown): WebfleetDriverActivity | null {
  if (!isRecord(value)) return null;
  const driverUid = str(value, 'driveruid');
  if (!driverUid) return null;
  return { driverUid, workState: num(value, 'current_workstate'), since: iso(value, 'current_workingtimeend') };
}

export function parseVehicleReportRow(value: unknown): WebfleetVehicleInfo | null {
  if (!isRecord(value)) return null;
  const objectUid = str(value, 'objectuid');
  if (!objectUid) return null;
  const tank = num(value, 'fueltanksize');
  return {
    objectUid,
    plate: str(value, 'licenseplatenumber')?.trim().slice(0, 20) || null,
    vin: str(value, 'identnumber')?.trim().slice(0, 20) || null,
    tankLiters: tank !== null && tank > 0 && tank <= 3000 ? tank : null
  };
}

export function parseCouplingRow(value: unknown): WebfleetCoupling | null {
  if (!isRecord(value)) return null;
  const vehicleUid = str(value, 'vehicleuid');
  const assetUid = str(value, 'assetuid');
  return vehicleUid && assetUid ? { vehicleUid, assetUid, coupledAt: iso(value, 'couplingtime') } : null;
}

export function parseEventRow(value: unknown): WebfleetEvent | null {
  if (!isRecord(value)) return null;
  const eventId = id(value, 'eventid');
  const at = iso(value, 'eventtime') ?? iso(value, 'msgtime');
  if (!eventId || !at) return null;
  const level = (str(value, 'eventlevel_cur') ?? str(value, 'eventlevel') ?? 'I').toUpperCase();
  return {
    id: eventId, at,
    objectUid: str(value, 'objectuid'),
    objectNo: str(value, 'objectno'),
    level: level === 'A' ? 'ALARM' : level === 'W' ? 'WARNING' : 'INFO',
    text: str(value, 'msgtext')?.trim().slice(0, 200) || 'Событие без описания',
    address: str(value, 'postext')?.trim().slice(0, 200) || null,
    resolved: Boolean(str(value, 'restime'))
  };
}

export function parseTripRow(value: unknown): WebfleetTrip | null {
  if (!isRecord(value)) return null;
  const tripId = id(value, 'tripid');
  const startAt = iso(value, 'start_time');
  if (!tripId || !startAt) return null;
  const distance = num(value, 'distance');
  return {
    id: tripId, startAt,
    objectUid: str(value, 'objectuid'),
    objectNo: str(value, 'objectno'),
    endAt: iso(value, 'end_time'),
    startAddress: str(value, 'start_postext')?.trim().slice(0, 200) || null,
    endAddress: str(value, 'end_postext')?.trim().slice(0, 200) || null,
    distanceKm: distance !== null ? Math.round(distance / 100) / 10 : null,
    businessTrip: num(value, 'tripmode') === 2
  };
}

export function parseOptiDriveRow(value: unknown) {
  if (!isRecord(value)) return null;
  const driverUid = str(value, 'driveruid');
  const indicator = num(value, 'optidrive_indicator');
  return driverUid && indicator !== null && indicator >= 0 && indicator <= 1 ? { driverUid, indicator } : null;
}

export function parseMaintenanceRow(value: unknown): WebfleetMaintenance | null {
  if (!isRecord(value)) return null;
  const name = str(value, 'schedulename')?.trim().slice(0, 100);
  if (!name) return null;
  const odometer = num(value, 'plannedexecodometer');
  return {
    name,
    objectUid: str(value, 'objectuid'),
    objectNo: str(value, 'objectno'),
    description: str(value, 'scheduledescription')?.trim().slice(0, 300) || null,
    dueAt: iso(value, 'plannedexectime'),
    dueOdometerKm: odometer !== null ? Math.round(odometer / 1000) : null
  };
}

function parseTrackRow(value: unknown) {
  if (!isRecord(value)) return null;
  const at = iso(value, 'pos_time');
  let latitude = num(value, 'latitude_mdeg') ?? num(value, 'latitude');
  let longitude = num(value, 'longitude_mdeg') ?? num(value, 'longitude');
  if (!at || latitude === null || longitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) { latitude /= 1e6; longitude /= 1e6; }
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { at: Date.parse(at), coordinate: [longitude, latitude] as [number, number] };
}

type LatestTelemetry = {
  recordedAt: Date; ageSeconds: number; stale: boolean; usable: boolean; latitude: number; longitude: number;
  speedKmh: number | null; ignitionOn: boolean | null; standstill: boolean | null; courseDeg: number | null; address: string | null;
  fuelPercent: number | null; odometerKm: number | null; engineHours: number | null; ignitionChangedAt: string | null; objectType: string | null;
  objectName?: string | null; tripMode?: number | null; lastContactAt?: Date | null;
};

function feedStatus(state: FeedState) {
  return state.at ? 'OK' as const : state.error ? 'UNAVAILABLE' as const : 'WAITING' as const;
}

export async function buildVehicleCard(
  db: PrismaClient,
  store: WebfleetLiveStore,
  latest: (vehicleId: string, now: Date) => Promise<LatestTelemetry | null>,
  vehicleId: string,
  now = new Date()
) {
  const vehicle = await db.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle) throw Object.assign(new Error('Грузовик не найден.'), { statusCode: 404 });
  const [binding, telemetry] = await Promise.all([
    db.vehicleIntegration.findUnique({ where: { provider_vehicleId: { provider: PROVIDER, vehicleId } } }),
    latest(vehicleId, now)
  ]);
  const active = binding?.status === 'ACTIVE' ? binding : null;
  const objectUid = active?.externalId ?? '';
  const objectNo = active?.externalNumber ?? null;
  const info = active ? store.vehicleInfo(objectUid) : null;
  const driver = active ? store.driverOn(objectUid, now) : undefined;
  const hours = driverHoursOf(store, driver);
  const { times, activity } = hours;
  const coupling = active ? store.coupling(objectUid) : null;
  const optiDrive = driver?.driverUid ? store.optiDriveScore(driver.driverUid) : null;
  const events = active ? store.eventsFor(objectUid, objectNo) : [];

  return {
    vehicleId: vehicle.id,
    vehicleNumber: vehicle.vehicleNumber,
    licensePlate: vehicle.licensePlate,
    currentTrailerPlate: vehicle.currentTrailerPlate,
    generatedAt: now.toISOString(),
    webfleet: active ? {
      objectNo,
      objectName: telemetry?.objectName ?? null,
      plate: info?.plate ?? null,
      vin: info?.vin ?? null,
      tankLiters: info?.tankLiters ?? null,
      objectType: telemetry?.objectType ?? null
    } : null,
    current: telemetry ? {
      recordedAt: telemetry.recordedAt.toISOString(),
      lastContactAt: telemetry.lastContactAt?.toISOString() ?? null,
      ageSeconds: telemetry.ageSeconds,
      stale: telemetry.stale,
      usable: telemetry.usable,
      coordinate: [telemetry.longitude, telemetry.latitude] as [number, number],
      address: telemetry.address,
      speedKmh: telemetry.speedKmh,
      courseDeg: telemetry.courseDeg,
      standstill: telemetry.standstill,
      ignitionOn: telemetry.ignitionOn,
      ignitionChangedAt: telemetry.ignitionChangedAt,
      fuelPercent: telemetry.fuelPercent,
      fuelLiters: telemetry.fuelPercent !== null && info?.tankLiters ? Math.round(info.tankLiters * telemetry.fuelPercent / 100) : null,
      odometerKm: telemetry.odometerKm,
      engineHours: telemetry.engineHours,
      businessTrip: telemetry.tripMode === 2
    } : null,
    coupling: !active ? null : {
      status: feedStatus(store.couplingFeed),
      assetUid: coupling?.assetUid ?? null,
      assetNo: coupling ? store.objectNo(coupling.assetUid) : null,
      coupledAt: coupling?.coupledAt ?? null
    },
    // undefined: no fresh object report in memory yet; null: nobody signed on.
    driver: !active ? null : driver === undefined ? { status: 'WAITING' as const } : driver === null ? { status: 'NONE' as const } : {
      status: 'SIGNED_ON' as const,
      name: driver.name ?? times?.name ?? null,
      workState: driver.workState,
      activitySince: hours.activitySince,
      checkedAt: new Date(store.objectsAt).toISOString(),
      drivingTimes: times,
      drivingTimesStatus: hours.timesStatus,
      optiDrive: optiDrive !== null ? Math.round(optiDrive * 1000) / 100 : null
    },
    events: !active ? null : { status: feedStatus(store.eventFeed), unresolved: events.filter((event) => !event.resolved).length, items: events.slice(0, 100) },
    trips: !active ? null : { status: feedStatus(store.tripFeed), items: store.tripsFor(objectUid, objectNo).slice(0, 50) },
    maintenance: !active ? null : { status: feedStatus(store.maintenanceFeed), items: store.maintenanceFor(objectUid, objectNo) }
  };
}

export type DriverHours = {
  /**
   * NO_WEBFLEET: the truck is not bound; WAITING: no fresh object report yet; NONE: nobody signed on;
   * RECENT: nobody signed on now, the figures are of the driver who last had the card in the truck (only when asked for).
   */
  status: 'SIGNED_ON' | 'NONE' | 'WAITING' | 'NO_WEBFLEET' | 'RECENT';
  workState: number | null; activitySince: string | null;
  times: WebfleetDrivingTimes | null;
  timesStatus: 'OK' | 'NO_DATA' | 'UNAVAILABLE' | 'WAITING';
};

function driverHoursOf(store: WebfleetLiveStore, driver: WebfleetDriverOnObject | null | undefined) {
  const times = driver?.driverUid ? store.drivingTimes(driver.driverUid) : null;
  const activity = driver?.driverUid ? store.activity(driver.driverUid) : null;
  return {
    times, activity,
    activitySince: activity && driver && activity.workState === driver.workState ? activity.since : null,
    timesStatus: times ? 'OK' as const : store.drivingFeed.error ? 'UNAVAILABLE' as const : store.drivingFeed.at ? 'NO_DATA' as const : 'WAITING' as const
  };
}

/** The signed-on driver's tachograph figures for a truck, from server memory only; no name, no driver id. */
export async function readDriverHours(db: PrismaClient, store: WebfleetLiveStore, vehicleId: string, now: Date, options: { recent?: boolean } = {}): Promise<DriverHours> {
  const binding = await db.vehicleIntegration.findUnique({ where: { provider_vehicleId: { provider: PROVIDER, vehicleId } } });
  if (!binding || binding.status !== 'ACTIVE') return { status: 'NO_WEBFLEET', workState: null, activitySince: null, times: null, timesStatus: 'NO_DATA' };
  const driver = store.driverOn(binding.externalId, now);
  if (driver === null && options.recent) {
    const last = store.lastDriverOn(binding.externalId, now);
    const times = last ? store.drivingTimes(last) : null;
    if (times) return { status: 'RECENT', workState: null, activitySince: null, times, timesStatus: 'OK' };
  }
  const hours = driverHoursOf(store, driver);
  return { status: driver === undefined ? 'WAITING' : driver === null ? 'NONE' : 'SIGNED_ON', workState: driver?.workState ?? null, activitySince: hours.activitySince, times: hours.times, timesStatus: hours.timesStatus };
}

export async function vehicleObjectUid(db: PrismaClient, vehicleId: string) {
  const binding = await db.vehicleIntegration.findUnique({ where: { provider_vehicleId: { provider: PROVIDER, vehicleId } } });
  if (!binding || binding.status !== 'ACTIVE') throw Object.assign(new Error('Машина не привязана к Webfleet.'), { statusCode: 404 });
  return binding.externalId;
}

export type WebfleetBindingSuggestion = {
  objectUid: string;
  objectNo: string | null;
  vehicleId: string;
  vehicleNumber: string;
  licensePlate: string | null;
  reason: 'EXACT' | 'NUMBER';
};

/**
 * Proposes pairs for objects the sync could not match. Nothing is bound here: an admin confirms each pair.
 * "B CY 2868" pairs with OPS "B-CY2868" (same plate) or, if that is the only candidate both ways, with OPS "2868".
 */
export async function suggestWebfleetBindings(db: PrismaClient, unmatched: Array<{ objectUid: string; objectNo?: string | null; licensePlate?: string | null; isTrailer?: boolean }>) {
  const [vehicles, bindings] = await Promise.all([
    db.vehicle.findMany({ select: { id: true, vehicleNumber: true, licensePlate: true } }),
    db.vehicleIntegration.findMany({ where: { provider: PROVIDER }, select: { vehicleId: true, externalId: true } })
  ]);
  const boundVehicles = new Set(bindings.map((item) => item.vehicleId));
  const boundObjects = new Set(bindings.map((item) => item.externalId));
  const free = vehicles.filter((vehicle) => !boundVehicles.has(vehicle.id));
  const objects = unmatched.filter((object) => !object.isTrailer && !boundObjects.has(object.objectUid) && normalizePlate(object.objectNo || object.licensePlate));
  const digitsOf = (value?: string | null) => /(\d+)\D*$/.exec(value ?? '')?.[1] ?? '';
  const objectsByDigits = new Map<string, number>();
  for (const object of objects) {
    const digits = digitsOf(object.objectNo || object.licensePlate);
    if (digits) objectsByDigits.set(digits, (objectsByDigits.get(digits) ?? 0) + 1);
  }

  const proposals: WebfleetBindingSuggestion[] = [];
  for (const object of objects) {
    const plate = normalizePlate(object.objectNo || object.licensePlate);
    const digits = digitsOf(object.objectNo || object.licensePlate);
    const exact = free.filter((vehicle) => normalizePlate(vehicle.vehicleNumber) === plate || normalizePlate(vehicle.licensePlate) === plate);
    const byNumber = digits && objectsByDigits.get(digits) === 1
      ? free.filter((vehicle) => normalizePlate(vehicle.vehicleNumber) === digits) : [];
    const [match, reason] = exact.length === 1 ? [exact[0], 'EXACT' as const] : exact.length === 0 && byNumber.length === 1 ? [byNumber[0], 'NUMBER' as const] : [null, null];
    if (match && reason) proposals.push({ objectUid: object.objectUid, objectNo: object.objectNo ?? null, vehicleId: match.id, vehicleNumber: match.vehicleNumber, licensePlate: match.licensePlate, reason });
  }
  // One OPS truck may be proposed for a single object only.
  const perVehicle = new Map<string, number>();
  for (const proposal of proposals) perVehicle.set(proposal.vehicleId, (perVehicle.get(proposal.vehicleId) ?? 0) + 1);
  return proposals.filter((proposal) => perVehicle.get(proposal.vehicleId) === 1);
}

function markOk(state: FeedState, now: Date) {
  Object.assign(state, { at: now.getTime(), error: null, providerCode: null });
}

function groupBy<T>(rows: T[], key: (row: T) => string | null, order: (a: T, b: T) => number) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    if (!id) continue;
    const list = groups.get(id) ?? [];
    list.push(row);
    groups.set(id, list);
  }
  for (const list of groups.values()) list.sort(order);
  return groups;
}

function compact<T>(rows: Array<T | null>) {
  return rows.filter((row): row is T => row !== null);
}

function thin<T>(points: T[], max: number) {
  if (points.length <= max) return points;
  const step = points.length / max;
  return Array.from({ length: max }, (_, index) => points[Math.floor(index * step)]).concat([points[points.length - 1]]);
}

/** Start of a UTC day relative to now, as ISO (useISO8601=true). */
function isoDay(now: Date, offsetDays: number) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
  return day.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: Record<string, unknown>, key: string) {
  return typeof value[key] === 'string' && value[key] ? value[key] as string : null;
}

/** Webfleet sends ids such as eventid and tripid as JSON numbers. */
function id(value: Record<string, unknown>, key: string) {
  const raw = value[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : str(value, key);
}

function num(value: Record<string, unknown>, key: string) {
  const raw = value[key];
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: Record<string, unknown>, key: string) {
  const raw = str(value, key);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The driver's hours for an ETA. With a card in the truck these are the tachograph budgets as of now; with the card out,
 * the last driver's figures say when the next shift may begin, and the drive is planned from there with a fresh day.
 * Null without Webfleet, without figures, or when they are older than an hour: the ETA then uses the calculated clock.
 */
export async function readDriverBudget(db: PrismaClient, store: WebfleetLiveStore, vehicleId: string, now: Date): Promise<DriverEtaInput | null> {
  const hours = await readDriverHours(db, store, vehicleId, now, { recent: true });
  if (!hours.times) return null;
  if (hours.status === 'SIGNED_ON') {
    const budget = driverBudgetFromWebfleet(hours.times, { workState: hours.workState, since: hours.activitySince }, now);
    return budget ? { budget, startsAt: null } : null;
  }
  if (hours.status === 'RECENT' && hours.times.earliestNextShiftAt) {
    const startsAt = new Date(hours.times.earliestNextShiftAt);
    if (Number.isFinite(startsAt.getTime()) && startsAt > now) return { budget: driverBudgetAfterRest(hours.times, startsAt), startsAt };
  }
  return null;
}
