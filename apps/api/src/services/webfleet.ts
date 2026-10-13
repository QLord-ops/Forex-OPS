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
  if (existing) return { vehicleId: existing.vehicleId, matchedBy: 'integration' as const, ambiguous: false };

  const byNumber = object.objectNo?.trim()
    ? await db.vehicle.findMany({ where: { vehicleNumber: object.objectNo.trim() } })
    : [];
  if (byNumber.length === 1) return { vehicleId: byNumber[0].id, matchedBy: 'objectNo' as const, ambiguous: false };
  if (byNumber.length > 1) return { vehicleId: null, matchedBy: 'objectNo' as const, ambiguous: true };

  const plate = normalizePlate(object.licensePlate);
  if (!plate) return { vehicleId: null, matchedBy: 'none' as const, ambiguous: false };
  const vehicles = await db.vehicle.findMany();
  const matches = vehicles.filter((vehicle) => {
    const vehiclePlate = normalizePlate(vehicle.licensePlate);
    return Boolean(vehiclePlate) && (vehiclePlate === plate || vehiclePlate.includes(plate) || plate.includes(vehiclePlate));
  });
  if (matches.length === 1) return { vehicleId: matches[0].id, matchedBy: 'plate' as const, ambiguous: false };
  return { vehicleId: null, matchedBy: 'plate' as const, ambiguous: matches.length > 1 };
}

export class WebfleetTelemetryService {
  constructor(private readonly db: PrismaClient) {}

  async applyPosition(input: WebfleetPosition, receivedAt = new Date()) {
    if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) throw new Error('Некорректные координаты Webfleet.');
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

    const arrivalConfirmed = await this.confirmArrivalIfStable(match.vehicleId, input, previous, receivedAt);
    if (messageId) {
      await this.db.integrationReceipt.create({ data: {
        provider: PROVIDER, messageId, externalId: input.objectUid, acknowledgedAt: receivedAt,
        payloadJson: JSON.stringify({ matchedBy: match.matchedBy, vehicleId: match.vehicleId, arrivalConfirmed })
      } });
    }
    return { duplicate: false, matched: true, vehicleId: match.vehicleId, arrivalConfirmed };
  }

  async latest(vehicleId: string, now = new Date()) {
    const telemetry = await this.db.vehicleTelemetry.findFirst({ where: { vehicleId, provider: PROVIDER }, orderBy: { recordedAt: 'desc' } });
    if (!telemetry) return null;
    const ageSeconds = Math.max(0, Math.floor((now.getTime() - telemetry.recordedAt.getTime()) / 1000));
    return { ...telemetry, ageSeconds, stale: ageSeconds > FRESH_SECONDS, usable: ageSeconds <= FALLBACK_SECONDS };
  }

  private async confirmArrivalIfStable(vehicleId: string, current: WebfleetPosition, previous: { latitude: number; longitude: number; speedKmh: number | null; recordedAt: Date } | null, now: Date) {
    if (freshAgeSeconds(current.recordedAt, now) > FRESH_SECONDS || (current.speedKmh ?? Infinity) > ARRIVAL_SPEED_KMH || !previous) return false;
    if ((previous.speedKmh ?? Infinity) > ARRIVAL_SPEED_KMH || previous.recordedAt >= current.recordedAt) return false;
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

    await this.db.$transaction(async (tx) => {
      const changed = await tx.stop.updateMany({ where: { id: stop.id, arrivedAt: null, completedAt: null }, data: { arrivedAt: current.recordedAt } });
      if (!changed.count) return;
      const leg = tour.legs.find((item) => item.toStopId === stop.id);
      if (leg) await tx.leg.update({ where: { id: leg.id }, data: { status: 'ARRIVED' } });
      await tx.operationEvent.create({ data: {
        vehicleId, tourId: tour.id, stopId: stop.id, type: 'ARRIVAL_CONFIRMED',
        payloadJson: JSON.stringify({ source: 'WEBFLEET_GEOFENCE', latitude: current.latitude, longitude: current.longitude, recordedAt: current.recordedAt })
      } });
      await tx.notification.upsert({
        where: { dedupKey: `webfleet-arrival:${stop.id}` },
        create: {
          dedupKey: `webfleet-arrival:${stop.id}`, vehicleId, stopId: stop.id, type: 'WEBFLEET_ARRIVAL',
          message: `Webfleet: машина прибыла ${stop.type === 'LOAD' ? 'на загрузку' : 'на выгрузку'}, ${stop.city || stop.address}.`,
          payloadJson: JSON.stringify({ source: 'WEBFLEET_GEOFENCE', stopId: stop.id, recordedAt: current.recordedAt })
        },
        update: { payloadJson: JSON.stringify({ source: 'WEBFLEET_GEOFENCE', stopId: stop.id, recordedAt: current.recordedAt }) }
      });
    });
    return true;
  }
}

export class WebfleetSyncService {
  private readonly telemetry: WebfleetTelemetryService;

  constructor(private readonly db: PrismaClient, private readonly config: WebfleetConfig | null = readWebfleetConfig()) {
    this.telemetry = new WebfleetTelemetryService(db);
  }

  get configured() {
    return Boolean(this.config);
  }

  async refreshIfDue(now = new Date()) {
    if (!this.config) return { configured: false, refreshed: false, reason: 'NOT_CONFIGURED' as const };
    const stateId = 'WEBFLEET:SNAPSHOT';
    await this.db.integrationSyncState.upsert({
      where: { id: stateId },
      create: { id: stateId, provider: PROVIDER },
      update: {}
    });
    const state = await this.db.integrationSyncState.findUnique({ where: { id: stateId } });
    if (state?.lastSnapshotAt && now.getTime() - state.lastSnapshotAt.getTime() < SNAPSHOT_INTERVAL_MS) {
      return { configured: true, refreshed: false, reason: 'NOT_DUE' as const, lastSnapshotAt: state.lastSnapshotAt };
    }
    const locked = await this.db.integrationSyncState.updateMany({
      where: { id: stateId, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      data: { lockedUntil: new Date(now.getTime() + SYNC_LEASE_MS) }
    });
    if (!locked.count) return { configured: true, refreshed: false, reason: 'LEASED' as const, lastSnapshotAt: state?.lastSnapshotAt ?? null };

    try {
      const positions = await fetchObjectReport(this.config);
      let matched = 0;
      for (const position of positions) {
        const result = await this.telemetry.applyPosition(position, now);
        if (result.matched) matched += 1;
      }
      await this.db.integrationSyncState.update({
        where: { id: stateId },
        data: { lastSnapshotAt: now, lockedUntil: null, cursor: JSON.stringify({ received: positions.length, matched }) }
      });
      return { configured: true, refreshed: true, received: positions.length, matched, lastSnapshotAt: now };
    } catch (error) {
      await this.db.integrationSyncState.update({ where: { id: stateId }, data: { lockedUntil: null } });
      throw error;
    }
  }

  async status() {
    const state = await this.db.integrationSyncState.findUnique({ where: { id: 'WEBFLEET:SNAPSHOT' } });
    return { configured: this.configured, lastSnapshotAt: state?.lastSnapshotAt ?? null, summary: state?.cursor ? safeJson(state.cursor) : null };
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
  url.searchParams.set('account', config.account);
  url.searchParams.set('apikey', config.apiKey);
  url.searchParams.set('action', 'showObjectReportExtern');
  url.searchParams.set('outputformat', 'json');
  url.searchParams.set('useUTF8', 'true');
  url.searchParams.set('useISO8601', 'true');
  const authorization = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  const response = await fetch(url, { headers: { Authorization: `Basic ${authorization}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Webfleet ответил HTTP ${response.status}.`);
  const payload = await response.json() as unknown;
  const rows = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.records) ? payload.records : [];
  return rows.map(parseObjectRow).filter((row): row is WebfleetPosition => row !== null);
}

function parseObjectRow(value: unknown): WebfleetPosition | null {
  if (!isRecord(value)) return null;
  const objectUid = stringField(value, ['objectuid', 'objectUid', 'objectid', 'objectId', 'objectno', 'objectNo']);
  const latitude = numberField(value, ['latitude', 'lat']);
  const longitude = numberField(value, ['longitude', 'lng', 'lon']);
  const recordedAtValue = stringField(value, ['pos_time', 'position_time', 'recordedAt', 'timestamp', 'msgtime']);
  const recordedAt = recordedAtValue ? new Date(recordedAtValue) : new Date();
  if (!objectUid || latitude === null || longitude === null || Number.isNaN(recordedAt.getTime())) return null;
  return {
    objectUid,
    objectNo: stringField(value, ['objectno', 'objectNo', 'objectname', 'objectName']),
    licensePlate: stringField(value, ['licenseplate', 'licensePlate', 'numberplate']),
    latitude,
    longitude,
    speedKmh: numberField(value, ['speed', 'speedKmh']),
    ignitionOn: booleanField(value, ['ignition', 'ignitionOn']),
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
    const parsed = typeof value[key] === 'number' ? value[key] : typeof value[key] === 'string' ? Number(value[key]) : NaN;
    if (Number.isFinite(parsed)) return parsed as number;
  }
  return null;
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
