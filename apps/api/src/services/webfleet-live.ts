import type { PrismaClient } from '@prisma/client';
import {
  normalizePlate, readWebfleetConfig, webfleetRequest, WebfleetError,
  type WebfleetConfig, type WebfleetDriverOnObject, type WebfleetErrorCategory, type WebfleetPosition, type WebfleetReadAction
} from './webfleet.js';

const PROVIDER = 'WEBFLEET';
export const DRIVING_TIMES_INTERVAL_MS = 5 * 60_000;
export const VEHICLE_REPORT_INTERVAL_MS = 60 * 60_000;
/** Extra reports run only right after a successful position snapshot, so wrong credentials cost one login, not three. */
const CREDENTIALS_PROVEN_MS = 3 * 60_000;
const DRIVER_LIVE_MS = 5 * 60_000;
const ERROR_DELAY_MS: Record<WebfleetErrorCategory, number> = {
  AUTH: 30 * 60_000, PERMISSION: 30 * 60_000, CONFIG: 30 * 60_000,
  RATE_LIMIT: 5 * 60_000, NETWORK: 5 * 60_000, INVALID_RESPONSE: 5 * 60_000, UNKNOWN: 5 * 60_000
};

export type WebfleetDrivingTimes = {
  driverUid: string;
  name: string | null;
  referenceTime: string | null;
  remainDrivingTodayMs: number | null;
  totalDrivingTodayMs: number | null;
  maxDrivingTodayMs: number | null;
  remainDrivingWeekMs: number | null;
  maxDrivingWeekMs: number | null;
  shiftStartedAt: string | null;
  latestShiftEndAt: string | null;
  nextBreakInMs: number | null;
  nextBreakMinMs: number | null;
  nextRestInMs: number | null;
  nextRestMinMs: number | null;
  earliestNextShiftAt: string | null;
  extendedShiftsLeft: number | null;
  maxExtendedShifts: number | null;
  reducedRestsLeft: number | null;
  maxReducedRests: number | null;
  infringements: boolean;
  lastCardActivityAt: string | null;
};

export type WebfleetVehicleInfo = {
  objectUid: string;
  plate: string | null;
  vin: string | null;
  tankLiters: number | null;
};

type FeedState = { at: number; nextAt: number; error: WebfleetErrorCategory | null; providerCode: number | null };

/**
 * Latest Webfleet facts kept in server memory. Driver names and driving times live only here:
 * they are never written to the database, history or logs (DSGVO), and refill within minutes after a restart.
 */
export class WebfleetLiveStore {
  private objects = new Map<string, { objectNo: string | null; licensePlate: string | null; isTrailer: boolean; driver: WebfleetDriverOnObject | null }>();
  private drivers = new Map<string, WebfleetDrivingTimes>();
  private vehicles = new Map<string, WebfleetVehicleInfo>();
  objectsAt = 0;
  readonly drivingFeed: FeedState = { at: 0, nextAt: 0, error: null, providerCode: null };
  readonly vehicleFeed: FeedState = { at: 0, nextAt: 0, error: null, providerCode: null };

  setObjects(positions: WebfleetPosition[], now: Date) {
    this.objects = new Map(positions.map((position) => [position.objectUid, {
      objectNo: position.objectNo ?? null, licensePlate: position.licensePlate ?? null, isTrailer: position.isTrailer === true, driver: position.driver ?? null
    }]));
    this.objectsAt = now.getTime();
  }

  setDrivingTimes(rows: WebfleetDrivingTimes[], now: Date) {
    this.drivers = new Map(rows.map((row) => [row.driverUid, row]));
    Object.assign(this.drivingFeed, { at: now.getTime(), error: null, providerCode: null });
  }

  setVehicles(rows: WebfleetVehicleInfo[], now: Date) {
    this.vehicles = new Map(rows.map((row) => [row.objectUid, row]));
    Object.assign(this.vehicleFeed, { at: now.getTime(), error: null, providerCode: null });
  }

  driverOn(objectUid: string, now: Date) {
    if (!this.objectsAt || now.getTime() - this.objectsAt > DRIVER_LIVE_MS) return undefined;
    return this.objects.get(objectUid)?.driver ?? null;
  }

  /** All objects of the last report, including trucks whose position is too old to be stored. */
  allObjects() {
    return [...this.objects].map(([objectUid, object]) => ({ objectUid, objectNo: object.objectNo, licensePlate: object.licensePlate, isTrailer: object.isTrailer }));
  }

  drivingTimes(driverUid: string) {
    return this.drivers.get(driverUid) ?? null;
  }

  vehicleInfo(objectUid: string) {
    return this.vehicles.get(objectUid) ?? null;
  }
}

/** Reads tachograph driving times every 5 min and vehicle master data hourly. Read-only reporting actions only. */
export class WebfleetDetailsSync {
  private running = false;

  constructor(
    private readonly store: WebfleetLiveStore,
    private readonly config: WebfleetConfig | null = readWebfleetConfig(),
    private readonly request: (config: WebfleetConfig, action: WebfleetReadAction) => Promise<unknown[]> = webfleetRequest
  ) {}

  async refreshIfDue(now = new Date()) {
    if (!this.config || this.running) return;
    if (!this.store.objectsAt || now.getTime() - this.store.objectsAt > CREDENTIALS_PROVEN_MS) return;
    this.running = true;
    try {
      await this.refreshFeed(this.store.drivingFeed, 'getRemainingDrivingTimesEU', DRIVING_TIMES_INTERVAL_MS, now,
        (rows) => this.store.setDrivingTimes(rows.map(parseDrivingTimesRow).filter((row): row is WebfleetDrivingTimes => row !== null), now));
      await this.refreshFeed(this.store.vehicleFeed, 'showVehicleReportExtern', VEHICLE_REPORT_INTERVAL_MS, now,
        (rows) => this.store.setVehicles(rows.map(parseVehicleReportRow).filter((row): row is WebfleetVehicleInfo => row !== null), now));
    } finally {
      this.running = false;
    }
  }

  private async refreshFeed(feed: FeedState, action: WebfleetReadAction, intervalMs: number, now: Date, apply: (rows: unknown[]) => void) {
    if (now.getTime() < feed.nextAt) return;
    try {
      apply(await this.request(this.config!, action));
      feed.nextAt = now.getTime() + intervalMs;
    } catch (error) {
      const failure = error instanceof WebfleetError ? error : new WebfleetError('UNKNOWN');
      Object.assign(feed, { error: failure.category, providerCode: failure.providerCode, nextAt: now.getTime() + ERROR_DELAY_MS[failure.category] });
    }
  }
}

export function parseDrivingTimesRow(value: unknown): WebfleetDrivingTimes | null {
  if (!isRecord(value)) return null;
  const driverUid = str(value, 'driveruid');
  if (!driverUid) return null;
  return {
    driverUid,
    name: str(value, 'drivername')?.trim().slice(0, 80) || null,
    referenceTime: iso(value, 'reference_time'),
    remainDrivingTodayMs: num(value, 'remain_driving_today'),
    totalDrivingTodayMs: num(value, 'total_driving_today'),
    maxDrivingTodayMs: num(value, 'max_driving_today'),
    remainDrivingWeekMs: num(value, 'remain_driving_week'),
    maxDrivingWeekMs: num(value, 'max_driving_week'),
    shiftStartedAt: iso(value, 'current_shift_start'),
    latestShiftEndAt: iso(value, 'latest_end_current_shift'),
    nextBreakInMs: num(value, 'next_break'),
    nextBreakMinMs: num(value, 'next_break_min_duration'),
    nextRestInMs: num(value, 'next_rest'),
    nextRestMinMs: num(value, 'next_rest_min_duration'),
    earliestNextShiftAt: iso(value, 'earliest_start_next_shift'),
    extendedShiftsLeft: num(value, 'extended_shifts'),
    maxExtendedShifts: num(value, 'max_extended_shifts'),
    reducedRestsLeft: num(value, 'reduced_rests'),
    maxReducedRests: num(value, 'max_reduced_rests'),
    infringements: value.infringements === true || value.infringements === 'true',
    lastCardActivityAt: iso(value, 'last_activity_from_drivercard')
  };
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

type LatestTelemetry = {
  recordedAt: Date; ageSeconds: number; stale: boolean; usable: boolean; latitude: number; longitude: number;
  speedKmh: number | null; ignitionOn: boolean | null; standstill: boolean | null; courseDeg: number | null; address: string | null;
  fuelPercent: number | null; odometerKm: number | null; engineHours: number | null; ignitionChangedAt: string | null; objectType: string | null;
};

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
  const info = active ? store.vehicleInfo(active.externalId) : null;
  const driver = active ? store.driverOn(active.externalId, now) : undefined;
  const times = driver?.driverUid ? store.drivingTimes(driver.driverUid) : null;
  const drivingFeed = store.drivingFeed;

  return {
    vehicleId: vehicle.id,
    vehicleNumber: vehicle.vehicleNumber,
    licensePlate: vehicle.licensePlate,
    currentTrailerPlate: vehicle.currentTrailerPlate,
    generatedAt: now.toISOString(),
    webfleet: active ? {
      objectNo: active.externalNumber,
      plate: info?.plate ?? null,
      vin: info?.vin ?? null,
      tankLiters: info?.tankLiters ?? null,
      objectType: telemetry?.objectType ?? null
    } : null,
    current: telemetry ? {
      recordedAt: telemetry.recordedAt.toISOString(),
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
      engineHours: telemetry.engineHours
    } : null,
    // undefined: no fresh object report in memory yet; null: nobody signed on.
    driver: !active ? null : driver === undefined ? { status: 'WAITING' as const } : driver === null ? { status: 'NONE' as const } : {
      status: 'SIGNED_ON' as const,
      name: driver.name ?? times?.name ?? null,
      workState: driver.workState,
      checkedAt: new Date(store.objectsAt).toISOString(),
      drivingTimes: times,
      drivingTimesStatus: times ? 'OK' as const : drivingFeed.error ? 'UNAVAILABLE' as const : drivingFeed.at ? 'NO_DATA' as const : 'WAITING' as const
    }
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: Record<string, unknown>, key: string) {
  return typeof value[key] === 'string' && value[key] ? value[key] as string : null;
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
