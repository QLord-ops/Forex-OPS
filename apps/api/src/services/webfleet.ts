import type { PrismaClient } from '@prisma/client';

const PROVIDER = 'WEBFLEET';
const ARRIVAL_RADIUS_METERS = 1000;
const ARRIVAL_SPEED_KMH = 20;
const FRESH_SECONDS = 120;
const FALLBACK_SECONDS = 30 * 60;
const SNAPSHOT_INTERVAL_MS = 60_000;
const SYNC_LEASE_MS = 45_000;

export type WebfleetObject = {
  objectUid: string;
  objectNo?: string | null;
  licensePlate?: string | null;
};

export type WebfleetPosition = WebfleetObject & {
  messageId?: string | null;
  latitude: number;
  longitude: number;
  speedKmh?: number | null;
  ignitionOn?: boolean | null;
  standstill?: boolean | null;
  recordedAt: Date;
  raw?: unknown;
};

type WebfleetConfig = {
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

export class WebfleetTelemetryService {
  constructor(private readonly db: PrismaClient) {}

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

    const previous = await this.db.vehicleTelemetry.findFirst({
      where: { vehicleId: match.vehicleId, provider: PROVIDER, recordedAt: { lt: input.recordedAt } },
      orderBy: { recordedAt: 'desc' }
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

    const arrivalSuggested = await this.suggestArrivalIfStable(match.vehicleId, input, previous, receivedAt);
    if (messageId) {
      await this.db.integrationReceipt.create({ data: {
        provider: PROVIDER, messageId, externalId: input.objectUid, acknowledgedAt: receivedAt,
        payloadJson: JSON.stringify({ matchedBy: match.matchedBy, vehicleId: match.vehicleId, arrivalSuggested })
      } });
    }
    return { duplicate: false, matched: true, vehicleId: match.vehicleId, arrivalConfirmed: false, arrivalSuggested };
  }

  async latest(vehicleId: string, now = new Date()) {
    const telemetry = await this.db.vehicleTelemetry.findFirst({ where: { vehicleId, provider: PROVIDER, recordedAt: { lte: now } }, orderBy: { recordedAt: 'desc' } });
    if (!telemetry) return null;
    const ageSeconds = Math.max(0, Math.floor((now.getTime() - telemetry.recordedAt.getTime()) / 1000));
    const payload = telemetry.rawJson ? safeJson(telemetry.rawJson) : null;
    return {
      ...telemetry,
      standstill: isRecord(payload) && typeof payload.standstill === 'boolean' ? payload.standstill : null,
      ageSeconds,
      stale: ageSeconds > FRESH_SECONDS,
      usable: ageSeconds <= FALLBACK_SECONDS
    };
  }

  private async suggestArrivalIfStable(vehicleId: string, current: WebfleetPosition, previous: { latitude: number; longitude: number; speedKmh: number | null; recordedAt: Date; rawJson: string | null } | null, now: Date) {
    const currentStopped = current.standstill === true || (typeof current.speedKmh === 'number' && current.speedKmh <= ARRIVAL_SPEED_KMH);
    const previousPayload = previous?.rawJson ? safeJson(previous.rawJson) : null;
    const previousStandstill = isRecord(previousPayload) && previousPayload.standstill === true;
    const previousStopped = previousStandstill || (typeof previous?.speedKmh === 'number' && previous.speedKmh <= ARRIVAL_SPEED_KMH);
    if (freshAgeSeconds(current.recordedAt, now) > FRESH_SECONDS || !currentStopped || !previous) return false;
    if (!previousStopped || previous.recordedAt >= current.recordedAt) return false;
    if (freshAgeSeconds(previous.recordedAt, now) > FRESH_SECONDS) return false;
    const tour = await this.db.tour.findFirst({
      where: { vehicleId, status: 'ACTIVE' },
      include: { stops: { orderBy: { sequence: 'asc' } }, legs: true },
      orderBy: { createdAt: 'asc' }
    });
    const stop = tour?.stops.find((item) => !item.completedAt);
    if (!tour || !stop || stop.arrivedAt) return false;
    const currentDistance = distanceMeters(current.latitude, current.longitude, stop.latitude, stop.longitude);
    const previousDistance = distanceMeters(previous.latitude, previous.longitude, stop.latitude, stop.longitude);
    if (currentDistance > ARRIVAL_RADIUS_METERS || previousDistance > ARRIVAL_RADIUS_METERS) return false;

    await this.db.notification.upsert({
      where: { dedupKey: `webfleet-arrival:${stop.id}` },
      create: {
        dedupKey: `webfleet-arrival:${stop.id}`, vehicleId, stopId: stop.id, type: 'PREDICTED_ARRIVAL',
        message: `Webfleet: машина предположительно прибыла ${stop.type === 'LOAD' ? 'на загрузку' : 'на выгрузку'}, ${stop.city || stop.address}. Подтвердите прибытие.`,
        payloadJson: JSON.stringify({ source: 'WEBFLEET_GEOFENCE', stopId: stop.id, recordedAt: current.recordedAt })
      },
      update: {}
    });
    return true;
  }
}

export class WebfleetSyncService {
  private readonly telemetry: WebfleetTelemetryService;
  private nextCheckAt = 0;

  constructor(private readonly db: PrismaClient, private readonly config: WebfleetConfig | null = readWebfleetConfig()) {
    this.telemetry = new WebfleetTelemetryService(db);
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
      const positions = await fetchObjectReport(this.config);
      let matched = 0;
      let rejected = 0;
      const unmatched: Array<WebfleetObject & { ambiguous: boolean }> = [];
      for (const position of positions) {
        if (position.recordedAt > now || freshAgeSeconds(position.recordedAt, now) > FALLBACK_SECONDS) { rejected += 1; continue; }
        const result = await this.telemetry.applyPosition(position, now);
        if (result.matched) matched += 1;
        else if (!result.duplicate && unmatched.length < 500) unmatched.push({ objectUid: position.objectUid, objectNo: position.objectNo, licensePlate: position.licensePlate, ambiguous: 'ambiguous' in result && Boolean(result.ambiguous) });
      }
      await this.db.integrationSyncState.update({
        where: { id: stateId },
        data: { lastSnapshotAt: now, lockedUntil: null, cursor: JSON.stringify({ received: positions.length, matched, rejected, unmatched, lastError: null }) }
      });
      this.nextCheckAt = now.getTime() + SNAPSHOT_INTERVAL_MS;
      return { configured: true, refreshed: true, received: positions.length, matched, lastSnapshotAt: now };
    } catch {
      const retryAfter = new Date(now.getTime() + 5 * SNAPSHOT_INTERVAL_MS);
      this.nextCheckAt = retryAfter.getTime();
      await this.db.integrationSyncState.update({ where: { id: stateId }, data: { lockedUntil: null, cursor: JSON.stringify({ ...(isRecord(summary) ? summary : {}), lastError: 'SYNC_FAILED', retryAfter: retryAfter.toISOString() }) } });
      return { configured: true, refreshed: false, reason: 'SYNC_FAILED' as const, lastSnapshotAt: state?.lastSnapshotAt ?? null };
    }
  }

  async status() {
    const state = await this.db.integrationSyncState.findUnique({ where: { id: 'WEBFLEET:SNAPSHOT' } });
    const summary = state?.cursor ? safeJson(state.cursor) : null;
    return { configured: this.configured, mode: 'READ_ONLY' as const, pollingIntervalSeconds: SNAPSHOT_INTERVAL_MS / 1000, lastSnapshotAt: state?.lastSnapshotAt ?? null, summary, lastError: isRecord(summary) ? summary.lastError ?? null : null, retryAfter: isRecord(summary) ? summary.retryAfter ?? null : null };
  }
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

async function fetchObjectReport(config: WebfleetConfig): Promise<WebfleetPosition[]> {
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'csv.webfleet.com' || url.pathname !== '/extern' || url.username || url.password) throw new Error('Недопустимый адрес Webfleet.');
  url.searchParams.set('account', config.account);
  url.searchParams.set('apikey', config.apiKey);
  url.searchParams.set('action', 'showObjectReportExtern');
  url.searchParams.set('outputformat', 'json');
  url.searchParams.set('useUTF8', 'true');
  url.searchParams.set('useISO8601', 'true');
  const authorization = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  const response = await fetch(url, { redirect: 'error', headers: { Authorization: `Basic ${authorization}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok || response.headers.has('X-Webfleet-Errorcode')) throw new Error('Ошибка Webfleet.');
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error('Неизвестный формат Webfleet.');
  const rows = payload;
  return rows.map(parseWebfleetObjectRow).filter((row): row is WebfleetPosition => row !== null);
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
    // Units for this report are not yet verified; never infer km/h from an untyped value.
    speedKmh: null,
    ignitionOn: booleanField(value, ['ignition', 'ignitionOn']),
    standstill: booleanField(value, ['standstill']),
    recordedAt,
    raw: undefined
  };
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
