import type { PrismaClient } from '@prisma/client';

const PROVIDER = 'WEBFLEET';
export const DEFAULT_ARRIVAL_RADIUS_METERS = 500;
// The truck must stand inside the zone this long; Webfleet snapshots arrive once a minute.
export const ARRIVAL_MIN_STANDSTILL_SECONDS = 180;
const ARRIVAL_HISTORY_SECONDS = 30 * 60;
const STOPPED_SPEED_KMH = 5;
const FRESH_SECONDS = 120;
const FALLBACK_SECONDS = 30 * 60;
const SNAPSHOT_INTERVAL_MS = 60_000;
const SYNC_LEASE_MS = 45_000;

export type WebfleetObject = {
  objectUid: string;
  objectNo?: string | null;
  licensePlate?: string | null;
};

/** Facts about the truck from the object report. They are not personal data, so they may be stored. */
export type WebfleetVehicleState = {
  courseDeg?: number | null;
  address?: string | null;
  fuelPercent?: number | null;
  odometerKm?: number | null;
  engineHours?: number | null;
  ignitionChangedAt?: string | null;
  objectType?: string | null;
  objectName?: string | null;
  /** WEBFLEET.connect tripmode: 1 private, 2 business, 3 commute. */
  tripMode?: number | null;
  isTrailer?: boolean;
};

/** Driver signed on to the object. Personal data: kept in memory only, never stored or logged. */
export type WebfleetDriverOnObject = {
  driverUid: string | null;
  name: string | null;
  workState: number | null;
};

export type WebfleetPosition = WebfleetObject & WebfleetVehicleState & {
  messageId?: string | null;
  latitude: number;
  longitude: number;
  speedKmh?: number | null;
  ignitionOn?: boolean | null;
  standstill?: boolean | null;
  recordedAt: Date;
  driver?: WebfleetDriverOnObject | null;
  raw?: unknown;
};

export type WebfleetConfig = {
  baseUrl: string;
  account: string;
  apiKey: string;
  username: string;
  password: string;
};

export function normalizePlate(value?: string | null) {
  return (value ?? '').toLocaleUpperCase('de-DE').replace(/[^A-Z0-9]/g, '');
}

export async function matchWebfleetObject(db: PrismaClient, object: WebfleetObject) {
  const existing = await db.vehicleIntegration.findUnique({
    where: { provider_externalId: { provider: PROVIDER, externalId: object.objectUid } }
  });
  if (existing) return { vehicleId: existing.status === 'ACTIVE' ? existing.vehicleId : null, matchedBy: 'integration' as const, ambiguous: existing.status !== 'ACTIVE' };
  const plate = normalizePlate(object.licensePlate);
  const vehicles = await db.vehicle.findMany();
  const byNumber = vehicles.filter((vehicle) => Boolean(object.objectNo?.trim()) && vehicle.vehicleNumber.trim().toUpperCase() === object.objectNo!.trim().toUpperCase());
  const byPlate = vehicles.filter((vehicle) => Boolean(plate) && normalizePlate(vehicle.licensePlate) === plate);
  const matches = [...new Map([...byNumber, ...byPlate].map((vehicle) => [vehicle.id, vehicle])).values()];
  if (matches.length !== 1) return { vehicleId: null, matchedBy: 'none' as const, ambiguous: matches.length > 1 };
  const binding = await db.vehicleIntegration.findUnique({ where: { provider_vehicleId: { provider: PROVIDER, vehicleId: matches[0].id } } });
  if (binding && binding.externalId !== object.objectUid) return { vehicleId: null, matchedBy: 'integration' as const, ambiguous: true };
  return { vehicleId: matches[0].id, matchedBy: byNumber.length ? 'objectNo' as const : 'plate' as const, ambiguous: false };
}

export type AutoArrivalInput = {
  stopId: string;
  arrivedAt: Date;
  now: Date;
  meta: { distanceMeters: number; radiusMeters: number; enteredAt: string; stoppedSince: string };
};
export type AutoArrivalHandler = (input: AutoArrivalInput) => Promise<{ applied?: boolean } | unknown>;
type ArrivalDecision = { suggested: boolean; confirmed: boolean };

export class WebfleetTelemetryService {
  /** Without a handler a fulfilled geofence only creates a suggestion for the dispatcher. */
  constructor(private readonly db: PrismaClient, private readonly onAutoArrival?: AutoArrivalHandler) {}

  async applyPosition(input: WebfleetPosition, receivedAt = new Date()) {
    if (!validCoordinates(input.latitude, input.longitude) || !Number.isFinite(input.recordedAt.getTime()) || input.recordedAt > receivedAt || !input.objectUid.trim()) throw new Error('Некорректная позиция Webfleet.');
    const messageId = input.messageId?.trim();
    if (messageId) {
      const receipt = await this.db.integrationReceipt.findUnique({ where: { provider_messageId: { provider: PROVIDER, messageId } } });
      if (receipt) return { duplicate: true, matched: false, arrivalConfirmed: false };
    }

    const match = await matchWebfleetObject(this.db, input);
    if (!match.vehicleId) {
      if (messageId) await this.db.integrationReceipt.create({ data: { provider: PROVIDER, messageId, externalId: input.objectUid, payloadJson: JSON.stringify({ unmatched: true, ambiguous: match.ambiguous }) } });
      return { duplicate: false, matched: false, ambiguous: match.ambiguous, arrivalConfirmed: false };
    }

    await this.db.vehicleIntegration.upsert({
      where: { provider_externalId: { provider: PROVIDER, externalId: input.objectUid } },
      create: { vehicleId: match.vehicleId, provider: PROVIDER, externalId: input.objectUid, externalNumber: input.objectNo, externalPlate: normalizePlate(input.licensePlate) || null },
      update: { vehicleId: match.vehicleId, externalNumber: input.objectNo, externalPlate: normalizePlate(input.licensePlate) || null, status: 'ACTIVE' }
    });

    await this.db.vehicleTelemetry.upsert({
      where: { provider_externalId_recordedAt: { provider: PROVIDER, externalId: input.objectUid, recordedAt: input.recordedAt } },
      create: {
        vehicleId: match.vehicleId, provider: PROVIDER, externalId: input.objectUid,
        latitude: input.latitude, longitude: input.longitude, speedKmh: input.speedKmh ?? null,
        ignitionOn: input.ignitionOn ?? null, recordedAt: input.recordedAt, receivedAt,
        rawJson: JSON.stringify(toSafeTelemetryPayload(input))
      },
      update: { receivedAt, speedKmh: input.speedKmh ?? null, rawJson: JSON.stringify(toSafeTelemetryPayload(input)) }
    });

    const arrival = await this.detectArrival(match.vehicleId, input, receivedAt);
    if (messageId) {
      await this.db.integrationReceipt.create({ data: {
        provider: PROVIDER, messageId, externalId: input.objectUid, acknowledgedAt: receivedAt,
        payloadJson: JSON.stringify({ matchedBy: match.matchedBy, vehicleId: match.vehicleId, arrivalSuggested: arrival.suggested, arrivalConfirmed: arrival.confirmed })
      } });
    }
    return { duplicate: false, matched: true, vehicleId: match.vehicleId, arrivalConfirmed: arrival.confirmed, arrivalSuggested: arrival.suggested };
  }

  async latest(vehicleId: string, now = new Date()) {
    const telemetry = await this.db.vehicleTelemetry.findFirst({ where: { vehicleId, provider: PROVIDER, recordedAt: { lte: now } }, orderBy: { recordedAt: 'desc' } });
    if (!telemetry) return null;
    const ageSeconds = Math.max(0, Math.floor((now.getTime() - telemetry.recordedAt.getTime()) / 1000));
    const payload = telemetry.rawJson ? safeJson(telemetry.rawJson) : null;
    return {
      ...telemetry,
      standstill: isRecord(payload) && typeof payload.standstill === 'boolean' ? payload.standstill : null,
      ...vehicleStateFromPayload(payload),
      objectNo: isRecord(payload) && typeof payload.objectNo === 'string' ? payload.objectNo : null,
      ageSeconds,
      stale: ageSeconds > FRESH_SECONDS,
      usable: ageSeconds <= FALLBACK_SECONDS
    };
  }

  /**
   * Geofence arrival from real GPS only: fresh position inside the stop zone and standing still
   * for ARRIVAL_MIN_STANDSTILL_SECONDS. The arrival time is when the truck entered the zone.
   */
  private async detectArrival(vehicleId: string, current: WebfleetPosition, now: Date): Promise<ArrivalDecision> {
    const none: ArrivalDecision = { suggested: false, confirmed: false };
    if (freshAgeSeconds(current.recordedAt, now) > FRESH_SECONDS || !isStopped(current.standstill, current.speedKmh)) return none;
    const tour = await this.db.tour.findFirst({
      where: { vehicleId, status: 'ACTIVE' },
      include: { stops: { orderBy: { sequence: 'asc' } }, legs: true },
      orderBy: [{ queueIndex: 'asc' }, { createdAt: 'asc' }]
    });
    const stop = tour?.stops.find((item) => !item.completedAt);
    if (!tour || !stop || stop.arrivedAt) return none;
    const radiusMeters = stop.arrivalRadiusMeters ?? DEFAULT_ARRIVAL_RADIUS_METERS;
    const distance = distanceMeters(current.latitude, current.longitude, stop.latitude, stop.longitude);
    if (distance > radiusMeters) return none;

    const history = await this.db.vehicleTelemetry.findMany({
      where: { vehicleId, provider: PROVIDER, recordedAt: { gte: new Date(current.recordedAt.getTime() - ARRIVAL_HISTORY_SECONDS * 1000), lte: current.recordedAt } },
      orderBy: { recordedAt: 'desc' }
    });
    let enteredAt: Date | null = null;
    let stoppedSince: Date | null = null;
    let stoppedRun = true;
    let leftZoneAt: Date | null = null;
    for (const row of history) {
      if (distanceMeters(row.latitude, row.longitude, stop.latitude, stop.longitude) > radiusMeters) { leftZoneAt = row.recordedAt; break; }
      enteredAt = row.recordedAt;
      const payload = row.rawJson ? safeJson(row.rawJson) : null;
      const standstill = isRecord(payload) && typeof payload.standstill === 'boolean' ? payload.standstill : null;
      if (stoppedRun && isStopped(standstill, row.speedKmh)) stoppedSince = row.recordedAt;
      else stoppedRun = false;
    }
    if (!enteredAt || !stoppedSince) return none;
    if ((current.recordedAt.getTime() - stoppedSince.getTime()) / 1000 < ARRIVAL_MIN_STANDSTILL_SECONDS) return none;

    // After a dispatcher reverted an arrival here, wait until the truck has left the zone and come back.
    const reverted = await this.db.operationEvent.findFirst({ where: { stopId: stop.id, type: 'ARRIVAL_REVERTED' }, orderBy: { createdAt: 'desc' } });
    if (reverted && (!leftZoneAt || leftZoneAt <= reverted.createdAt)) return none;

    const leg = tour.legs.find((item) => item.toStopId === stop.id);
    const arrivedAt = leg?.startedAt && leg.startedAt > enteredAt ? leg.startedAt : enteredAt;
    const meta = { distanceMeters: Math.round(distance), radiusMeters, enteredAt: enteredAt.toISOString(), stoppedSince: stoppedSince.toISOString() };

    if (this.onAutoArrival) {
      try {
        const result = await this.onAutoArrival({ stopId: stop.id, arrivedAt, now, meta });
        const applied = !isRecord(result) || result.applied !== false;
        return { suggested: false, confirmed: applied };
      } catch {
        // A conflicting change (e.g. the dispatcher just confirmed it) falls back to a suggestion.
      }
    }
    await this.db.notification.upsert({
      where: { dedupKey: `webfleet-arrival:${stop.id}` },
      create: {
        dedupKey: `webfleet-arrival:${stop.id}`, vehicleId, stopId: stop.id, type: 'PREDICTED_ARRIVAL',
        message: `Webfleet: машина стоит ${stop.type === 'LOAD' ? 'на загрузке' : 'на выгрузке'}, ${stop.city || stop.address}. Подтвердите прибытие.`,
        payloadJson: JSON.stringify({ source: 'WEBFLEET_GEOFENCE', stopId: stop.id, recordedAt: current.recordedAt, ...meta })
      },
      update: {}
    });
    return { suggested: true, confirmed: false };
  }
}

export class WebfleetSyncService {
  private readonly telemetry: WebfleetTelemetryService;
  private nextCheckAt = 0;

  constructor(
    private readonly db: PrismaClient,
    private readonly config: WebfleetConfig | null = readWebfleetConfig(),
    private readonly fetchReport: (config: WebfleetConfig) => Promise<WebfleetPosition[]> = fetchObjectReport,
    onAutoArrival?: AutoArrivalHandler,
    private readonly onSnapshot?: (positions: WebfleetPosition[], now: Date) => void
  ) {
    this.telemetry = new WebfleetTelemetryService(db, onAutoArrival);
  }

  get configured() {
    return Boolean(this.config);
  }

  async refreshIfDue(now = new Date()) {
    if (!this.config) return { configured: false, refreshed: false, reason: 'NOT_CONFIGURED' as const };
    if (now.getTime() < this.nextCheckAt) return { configured: true, refreshed: false, reason: 'NOT_DUE' as const };
    const stateId = 'WEBFLEET:SNAPSHOT';
    await this.db.integrationSyncState.upsert({
      where: { id: stateId },
      create: { id: stateId, provider: PROVIDER },
      update: {}
    });
    const state = await this.db.integrationSyncState.findUnique({ where: { id: stateId } });
    const summary = state?.cursor ? safeJson(state.cursor) : null;
    if (isRecord(summary) && typeof summary.retryAfter === 'string' && new Date(summary.retryAfter) > now) {
      this.nextCheckAt = new Date(summary.retryAfter).getTime();
      return { configured: true, refreshed: false, reason: 'COOLDOWN' as const, lastSnapshotAt: state?.lastSnapshotAt ?? null };
    }
    if (state?.lastSnapshotAt && now.getTime() - state.lastSnapshotAt.getTime() < SNAPSHOT_INTERVAL_MS) {
      this.nextCheckAt = state.lastSnapshotAt.getTime() + SNAPSHOT_INTERVAL_MS;
      return { configured: true, refreshed: false, reason: 'NOT_DUE' as const, lastSnapshotAt: state.lastSnapshotAt };
    }
    const locked = await this.db.integrationSyncState.updateMany({
      where: { id: stateId, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      data: { lockedUntil: new Date(now.getTime() + SYNC_LEASE_MS) }
    });
    if (!locked.count) { this.nextCheckAt = now.getTime() + 15_000; return { configured: true, refreshed: false, reason: 'LEASED' as const, lastSnapshotAt: state?.lastSnapshotAt ?? null }; }

    try {
      const positions = await this.fetchReport(this.config);
      this.onSnapshot?.(positions, now);
      let matched = 0;
      let rejected = 0;
      let failed = 0;
      const unmatched: Array<WebfleetObject & { ambiguous: boolean; isTrailer: boolean }> = [];
      for (const position of positions) {
        if (position.recordedAt > now || freshAgeSeconds(position.recordedAt, now) > FALLBACK_SECONDS) { rejected += 1; continue; }
        // One bad object must not stop positions for the rest of the fleet.
        let result: Awaited<ReturnType<typeof this.telemetry.applyPosition>>;
        try { result = await this.telemetry.applyPosition(position, now); }
        catch { failed += 1; continue; }
        if (result.matched) matched += 1;
        else if (!result.duplicate && unmatched.length < 500) unmatched.push({ objectUid: position.objectUid, objectNo: position.objectNo, licensePlate: position.licensePlate, ambiguous: 'ambiguous' in result && Boolean(result.ambiguous), isTrailer: position.isTrailer === true });
      }
      await this.db.integrationSyncState.update({
        where: { id: stateId },
        data: { lastSnapshotAt: now, lockedUntil: null, cursor: JSON.stringify({ received: positions.length, matched, rejected, failed, unmatched, lastError: null }) }
      });
      this.nextCheckAt = now.getTime() + SNAPSHOT_INTERVAL_MS;
      return { configured: true, refreshed: true, received: positions.length, matched, lastSnapshotAt: now };
    } catch (error) {
      const failure = error instanceof WebfleetError ? error : new WebfleetError('UNKNOWN');
      // Wrong credentials are retried slowly so repeated logins do not lock the Webfleet user.
      const retryAfter = new Date(now.getTime() + RETRY_DELAY_MS[failure.category]);
      this.nextCheckAt = retryAfter.getTime();
      await this.db.integrationSyncState.update({ where: { id: stateId }, data: { lockedUntil: null, cursor: JSON.stringify({
        ...(isRecord(summary) ? summary : {}),
        lastError: 'SYNC_FAILED',
        errorCategory: failure.category,
        providerErrorCode: failure.providerCode,
        failedAt: now.toISOString(),
        retryAfter: retryAfter.toISOString()
      }) } });
      return { configured: true, refreshed: false, reason: 'SYNC_FAILED' as const, errorCategory: failure.category, lastSnapshotAt: state?.lastSnapshotAt ?? null };
    }
  }

  async status() {
    const state = await this.db.integrationSyncState.findUnique({ where: { id: 'WEBFLEET:SNAPSHOT' } });
    const summary = state?.cursor ? safeJson(state.cursor) : null;
    const record = isRecord(summary) ? summary : null;
    return {
      configured: this.configured,
      mode: 'READ_ONLY' as const,
      pollingIntervalSeconds: SNAPSHOT_INTERVAL_MS / 1000,
      lastSnapshotAt: state?.lastSnapshotAt ?? null,
      summary,
      lastError: record?.lastError ?? null,
      errorCategory: record?.lastError && typeof record.errorCategory === 'string' ? record.errorCategory : null,
      providerErrorCode: record?.lastError && typeof record.providerErrorCode === 'number' ? record.providerErrorCode : null,
      retryAfter: record?.retryAfter ?? null
    };
  }

  /** Removes a freshly bound object from the stored "needs matching" list so the UI updates before the next snapshot. */
  async forgetUnmatched(objectUid: string) {
    const state = await this.db.integrationSyncState.findUnique({ where: { id: 'WEBFLEET:SNAPSHOT' } });
    const summary = state?.cursor ? safeJson(state.cursor) : null;
    if (!state || !isRecord(summary) || !Array.isArray(summary.unmatched)) return;
    const unmatched = summary.unmatched.filter((item) => !isRecord(item) || item.objectUid !== objectUid);
    await this.db.integrationSyncState.update({ where: { id: state.id }, data: { cursor: JSON.stringify({ ...summary, unmatched }) } });
  }
}

export type WebfleetErrorCategory = 'AUTH' | 'PERMISSION' | 'RATE_LIMIT' | 'NETWORK' | 'INVALID_RESPONSE' | 'CONFIG' | 'UNKNOWN';

const RETRY_DELAY_MS: Record<WebfleetErrorCategory, number> = {
  AUTH: 30 * 60_000,
  PERMISSION: 30 * 60_000,
  CONFIG: 30 * 60_000,
  RATE_LIMIT: 5 * 60_000,
  NETWORK: 5 * 60_000,
  INVALID_RESPONSE: 5 * 60_000,
  UNKNOWN: 5 * 60_000
};

/** Provider failure without account details: only a category and Webfleet's numeric code are kept. */
export class WebfleetError extends Error {
  constructor(readonly category: WebfleetErrorCategory, readonly providerCode: number | null = null) {
    super(`Webfleet: ${category}${providerCode === null ? '' : ` (${providerCode})`}`);
    this.name = 'WebfleetError';
  }
}

/** Maps a Webfleet error code/message to a category. The message is used for classification only and never stored. */
export function classifyWebfleetError(code: number | null, message: string | null, httpStatus?: number): WebfleetErrorCategory {
  const text = (message ?? '').toLowerCase();
  if (httpStatus === 429 || code === 8011 || /quota|limit|too many/.test(text)) return 'RATE_LIMIT';
  if (httpStatus === 401 || /auth|credential|password|login|apikey|api key|invalid user|account/.test(text)) return 'AUTH';
  if (httpStatus === 403 || /permission|not allowed|access denied|not authori[sz]ed|forbidden|right/.test(text)) return 'PERMISSION';
  if (httpStatus !== undefined && httpStatus >= 500) return 'NETWORK';
  return code === null && !text ? 'INVALID_RESPONSE' : 'UNKNOWN';
}

export async function bindWebfleetObject(db: PrismaClient, input: { objectUid: string; vehicleId: string; objectNo?: string | null; licensePlate?: string | null }) {
  const objectUid = input.objectUid.trim();
  if (!objectUid) throw Object.assign(new Error('Не указан объект Webfleet.'), { statusCode: 400 });
  const vehicle = await db.vehicle.findUnique({ where: { id: input.vehicleId } });
  if (!vehicle) throw Object.assign(new Error('Грузовик не найден.'), { statusCode: 404 });
  const byObject = await db.vehicleIntegration.findUnique({ where: { provider_externalId: { provider: PROVIDER, externalId: objectUid } } });
  if (byObject && byObject.vehicleId !== vehicle.id) throw Object.assign(new Error('Этот объект Webfleet уже привязан к другому грузовику. Сначала отвяжите его.'), { statusCode: 409 });
  const byVehicle = await db.vehicleIntegration.findUnique({ where: { provider_vehicleId: { provider: PROVIDER, vehicleId: vehicle.id } } });
  if (byVehicle && byVehicle.externalId !== objectUid) throw Object.assign(new Error('Грузовик уже привязан к другому объекту Webfleet. Сначала отвяжите его.'), { statusCode: 409 });
  return db.vehicleIntegration.upsert({
    where: { provider_externalId: { provider: PROVIDER, externalId: objectUid } },
    create: { vehicleId: vehicle.id, provider: PROVIDER, externalId: objectUid, externalNumber: input.objectNo?.trim() || null, externalPlate: normalizePlate(input.licensePlate) || null, status: 'ACTIVE' },
    update: { status: 'ACTIVE', externalNumber: input.objectNo?.trim() || undefined, externalPlate: normalizePlate(input.licensePlate) || undefined }
  });
}

/** Deletes only the binding. Stored telemetry stays as history. */
export async function unbindWebfleetVehicle(db: PrismaClient, vehicleId: string) {
  const binding = await db.vehicleIntegration.findUnique({ where: { provider_vehicleId: { provider: PROVIDER, vehicleId } } });
  if (!binding) throw Object.assign(new Error('Привязка Webfleet не найдена.'), { statusCode: 404 });
  await db.vehicleIntegration.delete({ where: { id: binding.id } });
  return binding;
}

export async function listWebfleetBindings(db: PrismaClient) {
  const rows = await db.vehicleIntegration.findMany({
    where: { provider: PROVIDER },
    include: { vehicle: { select: { id: true, vehicleNumber: true, licensePlate: true } } },
    orderBy: { createdAt: 'asc' }
  });
  return rows.map((row) => ({
    vehicleId: row.vehicleId,
    vehicleNumber: row.vehicle.vehicleNumber,
    licensePlate: row.vehicle.licensePlate,
    objectUid: row.externalId,
    objectNo: row.externalNumber,
    externalPlate: row.externalPlate,
    status: row.status,
    boundAt: row.createdAt
  }));
}

export function readWebfleetConfig(env = process.env): WebfleetConfig | null {
  const account = env.WEBFLEET_ACCOUNT?.trim();
  const apiKey = env.WEBFLEET_API_KEY?.trim();
  const username = env.WEBFLEET_USERNAME?.trim();
  const password = env.WEBFLEET_PASSWORD?.trim();
  if (!account || !apiKey || !username || !password) return null;
  return {
    baseUrl: env.WEBFLEET_BASE_URL?.trim() || 'https://csv.webfleet.com/extern',
    account,
    apiKey,
    username,
    password
  };
}

/** Only reporting actions are allowed: Webfleet stays read-only. */
export type WebfleetReadAction = 'showObjectReportExtern' | 'showVehicleReportExtern' | 'getRemainingDrivingTimesEU' | 'showDriverReportExtern'
  | 'getActiveAssetCouplings' | 'showEventReportExtern' | 'showTripReportExtern' | 'showOptiDriveIndicator' | 'showMaintenanceSchedules' | 'showTracks';

export async function fetchObjectReport(config: WebfleetConfig, fetchImpl: typeof fetch = fetch): Promise<WebfleetPosition[]> {
  const rows = await webfleetRequest(config, 'showObjectReportExtern', {}, fetchImpl);
  return rows.map(parseWebfleetObjectRow).filter((row): row is WebfleetPosition => row !== null);
}

export async function webfleetRequest(config: WebfleetConfig, action: WebfleetReadAction, params: Record<string, string> = {}, fetchImpl: typeof fetch = fetch): Promise<unknown[]> {
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'csv.webfleet.com' || url.pathname !== '/extern' || url.username || url.password) throw new WebfleetError('CONFIG');
  url.searchParams.set('account', config.account);
  url.searchParams.set('apikey', config.apiKey);
  url.searchParams.set('action', action);
  // Required by WEBFLEET.connect; without it every request fails with 8105.
  url.searchParams.set('lang', 'de');
  url.searchParams.set('outputformat', 'json');
  url.searchParams.set('useUTF8', 'true');
  url.searchParams.set('useISO8601', 'true');
  for (const [key, value] of Object.entries(params)) if (!['account', 'apikey', 'action', 'username', 'password'].includes(key)) url.searchParams.set(key, value);
  const authorization = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'error', headers: { Authorization: `Basic ${authorization}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new WebfleetError('NETWORK');
  }
  const headerCode = parseErrorCode(response.headers.get('X-Webfleet-Errorcode'));
  if (!response.ok || headerCode !== null) {
    throw new WebfleetError(classifyWebfleetError(headerCode, response.headers.get('X-Webfleet-Errormessage'), response.ok ? undefined : response.status), headerCode);
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new WebfleetError('INVALID_RESPONSE'); }
  // With outputformat=json Webfleet reports errors as an object { errorCode, errorMsg } and HTTP 200.
  if (isRecord(payload) && !Array.isArray(payload)) {
    const code = parseErrorCode(payload.errorCode ?? payload.errorcode);
    const message = typeof payload.errorMsg === 'string' ? payload.errorMsg : typeof payload.errormsg === 'string' ? payload.errormsg : null;
    throw new WebfleetError(code === null && message === null ? 'INVALID_RESPONSE' : classifyWebfleetError(code, message), code);
  }
  if (!Array.isArray(payload)) throw new WebfleetError('INVALID_RESPONSE');
  return payload;
}

function parseErrorCode(value: unknown) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

export function parseWebfleetObjectRow(value: unknown): WebfleetPosition | null {
  if (!isRecord(value)) return null;
  if (value.status !== 'A') return null;
  const objectUid = stringField(value, ['objectuid']);
  const latitudeRaw = numberField(value, ['latitude_mdeg']);
  const longitudeRaw = numberField(value, ['longitude_mdeg']);
  const latitude = latitudeRaw === null ? NaN : latitudeRaw / 1e6;
  const longitude = longitudeRaw === null ? NaN : longitudeRaw / 1e6;
  const recordedAtValue = stringField(value, ['pos_time']);
  const recordedAt = new Date(recordedAtValue ?? '');
  if (!objectUid || !validCoordinates(latitude, longitude) || Number.isNaN(recordedAt.getTime())) return null;
  return {
    objectUid,
    objectNo: stringField(value, ['objectno', 'objectNo', 'objectname', 'objectName']),
    licensePlate: stringField(value, ['licenseplate', 'licensePlate', 'numberplate']),
    latitude,
    longitude,
    // Units per WEBFLEET.connect: speed km/h, fuellevel per mill, odometer_long metres (odometer 100 m), engine time seconds.
    speedKmh: inRange(numberField(value, ['speed']), 0, 200),
    courseDeg: inRange(numberField(value, ['course']), 0, 360),
    address: stringField(value, ['postext', 'postext_short'])?.trim().slice(0, 200) || null,
    fuelPercent: round1(divide(inRange(numberField(value, ['fuellevel']), 0, 1000), 10)),
    odometerKm: round1(divide(numberField(value, ['odometer_long']), 1000) ?? divide(numberField(value, ['odometer']), 10)),
    engineHours: round1(divide(numberField(value, ['engine_operating_time', 'engine_operation_time']), 3600)),
    ignitionChangedAt: isoOrNull(stringField(value, ['ignition_time'])),
    objectType: stringField(value, ['objecttype'])?.slice(0, 40) ?? null,
    objectName: stringField(value, ['objectname'])?.trim().slice(0, 60) || null,
    tripMode: inRange(numberField(value, ['tripmode']), 0, 4),
    isTrailer: stringField(value, ['objectclassname']) === 'Anhänger' || stringField(value, ['objecttype']) === 'trailer',
    ignitionOn: booleanField(value, ['ignition', 'ignitionOn']),
    standstill: booleanField(value, ['standstill']),
    recordedAt,
    driver: stringField(value, ['driveruid', 'drivername']) ? {
      driverUid: stringField(value, ['driveruid']),
      name: stringField(value, ['drivername'])?.trim().slice(0, 80) || null,
      workState: numberField(value, ['driver_currentworkstate'])
    } : null,
    raw: undefined
  };
}

/** Driver fields are deliberately absent: only facts about the truck go into stored history. */
const STORED_VEHICLE_FIELDS = ['courseDeg', 'address', 'fuelPercent', 'odometerKm', 'engineHours', 'ignitionChangedAt', 'objectType', 'objectName', 'tripMode', 'isTrailer'] as const;

export function vehicleStateFromPayload(payload: unknown): Required<WebfleetVehicleState> {
  const record = isRecord(payload) ? payload : {};
  const num = (key: string) => typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] as number : null;
  const str = (key: string) => typeof record[key] === 'string' ? record[key] as string : null;
  return {
    courseDeg: num('courseDeg'), address: str('address'), fuelPercent: num('fuelPercent'), odometerKm: num('odometerKm'),
    engineHours: num('engineHours'), ignitionChangedAt: str('ignitionChangedAt'), objectType: str('objectType'), objectName: str('objectName'),
    tripMode: num('tripMode'), isTrailer: record.isTrailer === true
  };
}

function inRange(value: number | null, min: number, max: number) {
  return value !== null && value >= min && value <= max ? value : null;
}

function divide(value: number | null, by: number) {
  return value === null ? null : value / by;
}

function round1(value: number | null) {
  return value === null ? null : Math.round(value * 10) / 10;
}

function isoOrNull(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toSafeTelemetryPayload(input: WebfleetPosition) {
  return {
    objectUid: input.objectUid,
    objectNo: input.objectNo ?? null,
    licensePlate: input.licensePlate ?? null,
    latitude: input.latitude,
    longitude: input.longitude,
    speedKmh: input.speedKmh ?? null,
    ignitionOn: input.ignitionOn ?? null,
    standstill: input.standstill ?? null,
    ...Object.fromEntries(STORED_VEHICLE_FIELDS.map((key) => [key, input[key] ?? null])),
    recordedAt: input.recordedAt.toISOString()
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  return null;
}

function numberField(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const parsed = typeof value[key] === 'number' ? value[key] : typeof value[key] === 'string' && value[key].trim() ? Number(value[key]) : NaN;
    if (Number.isFinite(parsed)) return parsed as number;
  }
  return null;
}

function validCoordinates(latitude: number, longitude: number) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

function booleanField(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'boolean') return field;
    if (field === 1 || field === '1' || field === 'true' || field === 'on') return true;
    if (field === 0 || field === '0' || field === 'false' || field === 'off') return false;
  }
  return null;
}

function safeJson(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function freshAgeSeconds(recordedAt: Date, now: Date) {
  return Math.max(0, Math.floor((now.getTime() - recordedAt.getTime()) / 1000));
}

export function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number) {
  const radius = 6371000;
  const phi1 = toRadians(aLat);
  const phi2 = toRadians(bLat);
  const deltaPhi = toRadians(bLat - aLat);
  const deltaLambda = toRadians(bLon - aLon);
  const value = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function toRadians(value: number) {
  return value * Math.PI / 180;
}

function isStopped(standstill: boolean | null | undefined, speedKmh: number | null | undefined) {
  if (standstill === true) return true;
  if (standstill === false) return false;
  return typeof speedKmh === 'number' && speedKmh <= STOPPED_SPEED_KMH;
}
