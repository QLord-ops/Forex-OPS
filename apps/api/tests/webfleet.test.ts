import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { OperationsService, SYSTEM_WEBFLEET_ACTOR } from '../src/services/operations.js';
import { TourService } from '../src/services/tours.js';
import { bindWebfleetObject, distanceMeters, fetchObjectReport, listWebfleetBindings, matchWebfleetObject, parseWebfleetObjectRow, unbindWebfleetVehicle, WebfleetError, WebfleetSyncService, WebfleetTelemetryService } from '../src/services/webfleet.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;
let service: WebfleetTelemetryService;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 10, minute));

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-webfleet-test-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
  service = new WebfleetTelemetryService(db as unknown as PostgresPrismaClient);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('matches normalized registration plates without treating an empty plate as a match', async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: '936', licensePlate: 'HH-AB 936' } });
  await db.vehicle.create({ data: { vehicleNumber: 'EMPTY', licensePlate: '' } });
  const matched = await matchWebfleetObject(db as unknown as PostgresPrismaClient, {
    objectUid: 'wf-936',
    licensePlate: 'HHAB936'
  });
  expect(matched).toMatchObject({ vehicleId: vehicle.id, matchedBy: 'plate', ambiguous: false });
});

it('refuses an ambiguous object instead of attaching telemetry to the wrong vehicle', async () => {
  await db.vehicle.create({ data: { vehicleNumber: 'WF-CONFLICT', licensePlate: 'B-ONE 1' } });
  await db.vehicle.create({ data: { vehicleNumber: 'OTHER', licensePlate: 'B-TWO 2' } });
  const matched = await matchWebfleetObject(db as unknown as PostgresPrismaClient, {
    objectUid: 'wf-conflict', objectNo: 'WF-CONFLICT', licensePlate: 'B-TWO 2'
  });
  expect(matched).toEqual({ vehicleId: null, matchedBy: 'none', ambiguous: true });
});

it('does not let a second Webfleet object take over an existing vehicle binding', async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'WF-BOUND', licensePlate: 'B-BOUND 1' } });
  await db.vehicleIntegration.create({ data: { vehicleId: vehicle.id, provider: 'WEBFLEET', externalId: 'wf-original', status: 'ACTIVE' } });
  const matched = await matchWebfleetObject(db as unknown as PostgresPrismaClient, {
    objectUid: 'wf-impostor', objectNo: 'WF-BOUND', licensePlate: 'B-BOUND 1'
  });
  expect(matched).toEqual({ vehicleId: null, matchedBy: 'integration', ambiguous: true });
});

const BERLIN = { latitude: 52.52, longitude: 13.405 };
const HAMBURG = { latitude: 53.55, longitude: 9.99 };
// ~111 m per 0.001 degree of latitude.
const north = (meters: number) => ({ latitude: BERLIN.latitude + meters / 111_000, longitude: BERLIN.longitude });

async function arrivalScenario(name: string, options: { radius?: number } = {}) {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: name, licensePlate: `B-${name}` } });
  const tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const tour = await tours.createTour({ vehicleId: vehicle.id, orderNumber: `ORD-${name}`, stops: [
    { sequence: 1, type: 'LOAD', address: 'Berlin', city: 'Berlin', ...BERLIN },
    { sequence: 2, type: 'UNLOAD', address: 'Hamburg', city: 'Hamburg', ...HAMBURG }
  ] });
  if (options.radius) await db.stop.update({ where: { id: tour.stops[0].id }, data: { arrivalRadiusMeters: options.radius } });
  const operations = new OperationsService(asAppDatabase(db), tours);
  const auto = new WebfleetTelemetryService(db as unknown as PostgresPrismaClient, (input) =>
    operations.confirmArrival(input.stopId, input.arrivedAt, input.now, SYSTEM_WEBFLEET_ACTOR, { source: 'WEBFLEET_AUTO', meta: input.meta }));
  const feed = async (minute: number, point: { latitude: number; longitude: number }, standstill: boolean, receivedLagSeconds = 30) =>
    auto.applyPosition({ objectUid: `wf-${name}`, objectNo: name, ...point, standstill, recordedAt: at(minute) }, new Date(at(minute).getTime() + receivedLagSeconds * 1000));
  return { vehicle, tour, stopId: tour.stops[0].id, operations, tours, feed };
}

it('sets the arrival automatically after three minutes standing inside the 500 m zone, timed at zone entry', async () => {
  const { stopId, feed } = await arrivalScenario('AUTO-OK');
  await feed(0, north(2000), false);
  await feed(1, north(300), false);
  for (const minute of [2, 3, 4]) expect((await feed(minute, north(120), true)).arrivalConfirmed).toBe(false);
  const result = await feed(5, north(100), true);
  expect(result).toMatchObject({ arrivalConfirmed: true, arrivalSuggested: false });
  expect((await db.stop.findUniqueOrThrow({ where: { id: stopId } })).arrivedAt).toEqual(at(1));
  const events = await db.operationEvent.findMany({ where: { stopId, type: 'ARRIVAL_CONFIRMED' } });
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0].payloadJson)).toMatchObject({ source: 'WEBFLEET_AUTO', radiusMeters: 500 });
  expect(await db.notification.count({ where: { stopId, type: 'AUTO_ARRIVAL', acknowledgedAt: null } })).toBe(1);
  expect(await db.auditLog.findFirst({ where: { stopId, action: 'ARRIVAL_CONFIRMED' } })).toMatchObject({ actorRole: 'system', actorSessionId: 'webfleet-auto' });
  // Further positions do not create a second arrival.
  await feed(6, north(100), true);
  expect(await db.operationEvent.count({ where: { stopId, type: 'ARRIVAL_CONFIRMED' } })).toBe(1);
});

it('waits while the truck has stood in the zone for less than three minutes', async () => {
  const { stopId, feed } = await arrivalScenario('AUTO-SHORT');
  for (const minute of [0, 1, 2]) await feed(minute, north(100), true);
  expect((await db.stop.findUniqueOrThrow({ where: { id: stopId } })).arrivedAt).toBeNull();
});

it('ignores a truck passing through the zone without stopping', async () => {
  const { stopId, feed } = await arrivalScenario('AUTO-PASS');
  for (const minute of [0, 1, 2, 3, 4, 5]) await feed(minute, north(150), false);
  expect((await db.stop.findUniqueOrThrow({ where: { id: stopId } })).arrivedAt).toBeNull();
});

it('uses 500 m by default and a larger zone when the stop has one', async () => {
  const outside = await arrivalScenario('AUTO-800');
  for (const minute of [0, 1, 2, 3, 4]) await outside.feed(minute, north(800), true);
  expect((await db.stop.findUniqueOrThrow({ where: { id: outside.stopId } })).arrivedAt).toBeNull();

  const wide = await arrivalScenario('AUTO-WIDE', { radius: 1000 });
  for (const minute of [0, 1, 2, 3, 4]) await wide.feed(minute, north(800), true);
  expect((await db.stop.findUniqueOrThrow({ where: { id: wide.stopId } })).arrivedAt).toEqual(at(0));
});

it('never sets an arrival from stale GPS', async () => {
  const { stopId, feed } = await arrivalScenario('AUTO-STALE');
  for (const minute of [0, 1, 2, 3, 4]) await feed(minute, north(100), true, 10 * 60);
  expect((await db.stop.findUniqueOrThrow({ where: { id: stopId } })).arrivedAt).toBeNull();
});

it('sets the arrival for a parked truck whose pos_time stays put while the unit keeps reporting', async () => {
  const { stopId, feed } = await arrivalScenario('AUTO-PARKED');
  await feed(0, north(2000), false);
  const parked = (contactMinute: number) => ({ ...north(90), standstill: true, recordedAt: at(1), lastContactAt: at(contactMinute) });
  const telemetry = new WebfleetTelemetryService(db as unknown as PostgresPrismaClient, async (input) =>
    new OperationsService(asAppDatabase(db), new TourService(asAppDatabase(db), new MockRoutingProvider()))
      .confirmArrival(input.stopId, input.arrivedAt, input.now, SYSTEM_WEBFLEET_ACTOR, { source: 'WEBFLEET_AUTO', meta: input.meta }));
  // Webfleet keeps pos_time 10:01 while the truck stands; only msgtime moves on.
  for (const minute of [2, 3]) await telemetry.applyPosition({ objectUid: 'wf-AUTO-PARKED', objectNo: 'AUTO-PARKED', ...parked(minute) }, new Date(at(minute).getTime() + 20_000));
  expect((await db.stop.findUniqueOrThrow({ where: { id: stopId } })).arrivedAt).toBeNull();
  const result = await telemetry.applyPosition({ objectUid: 'wf-AUTO-PARKED', objectNo: 'AUTO-PARKED', ...parked(4) }, new Date(at(4).getTime() + 20_000));
  expect(result.arrivalConfirmed).toBe(true);
  expect((await db.stop.findUniqueOrThrow({ where: { id: stopId } })).arrivedAt).toEqual(at(1));
  const latest = await telemetry.latest((await db.stop.findUniqueOrThrow({ where: { id: stopId }, include: { tour: true } })).tour.vehicleId, new Date(at(4).getTime() + 20_000));
  expect(latest).toMatchObject({ stale: false, recordedAt: at(1), lastContactAt: at(4) });
});

it('does not trust a parked position when the unit has been silent for more than five minutes', async () => {
  const { stopId } = await arrivalScenario('AUTO-SILENT');
  const telemetry = new WebfleetTelemetryService(db as unknown as PostgresPrismaClient, async () => ({ applied: true }));
  for (const minute of [10, 11]) {
    await telemetry.applyPosition({ objectUid: 'wf-AUTO-SILENT', objectNo: 'AUTO-SILENT', ...north(90), standstill: true, recordedAt: at(0), lastContactAt: at(2) }, at(minute));
  }
  expect((await db.stop.findUniqueOrThrow({ where: { id: stopId } })).arrivedAt).toBeNull();
  const latest = await telemetry.latest((await db.stop.findUniqueOrThrow({ where: { id: stopId }, include: { tour: true } })).tour.vehicleId, at(11));
  expect(latest?.stale).toBe(true);
});

it('reads msgtime as the last unit contact', () => {
  const row = parseWebfleetObjectRow({ status: 'A', objectuid: 'obj-test-9', latitude_mdeg: 52520000, longitude_mdeg: 13405000, pos_time: '2026-10-13T10:01:00Z', msgtime: '2026-10-13T10:09:00Z', standstill: '1' });
  expect(row?.lastContactAt?.toISOString()).toBe('2026-10-13T10:09:00.000Z');
});

it('loads and unloads at the same place one after another without leaving the zone', async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'SAME-PLACE', licensePlate: 'B-SAME 1' } });
  const tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const tour = await tours.createTour({ vehicleId: vehicle.id, orderNumber: 'ORD-SAME', stops: [
    { sequence: 1, type: 'LOAD', address: 'Werk Zwickau', city: 'Zwickau', ...BERLIN },
    { sequence: 2, type: 'UNLOAD', address: 'Werk Zwickau Halle 2', city: 'Zwickau', ...north(200) }
  ] });
  const operations = new OperationsService(asAppDatabase(db), tours);
  const auto = new WebfleetTelemetryService(db as unknown as PostgresPrismaClient, (input) =>
    operations.confirmArrival(input.stopId, input.arrivedAt, input.now, SYSTEM_WEBFLEET_ACTOR, { source: 'WEBFLEET_AUTO', meta: input.meta }));
  const feed = (minute: number) => auto.applyPosition({ objectUid: 'wf-same', objectNo: 'SAME-PLACE', ...north(100), standstill: true, recordedAt: at(minute) }, new Date(at(minute).getTime() + 20_000));
  for (const minute of [0, 1, 2, 3]) await feed(minute);
  expect((await db.stop.findUniqueOrThrow({ where: { id: tour.stops[0].id } })).arrivedAt).toEqual(at(0));
  expect((await db.stop.findUniqueOrThrow({ where: { id: tour.stops[1].id } })).arrivedAt).toBeNull();
  await tours.recordLoaded(tour.stops[0].id, at(30));
  for (const minute of [31, 32, 33, 34]) await feed(minute);
  expect((await db.stop.findUniqueOrThrow({ where: { id: tour.stops[1].id } })).arrivedAt).toEqual(at(30));
});

it('after a revert waits until the truck has left the zone and come back', async () => {
  const { stopId, feed, operations } = await arrivalScenario('AUTO-REVERT');
  for (const minute of [0, 1, 2, 3]) await feed(minute, north(100), true);
  expect((await db.stop.findUniqueOrThrow({ where: { id: stopId } })).arrivedAt).toEqual(at(0));

  await operations.revertArrival(stopId, new Date(at(3).getTime() + 40_000), { role: 'dispatcher', sessionId: 's1' }, 'Стоял у соседнего склада');
  const reverted = await db.stop.findUniqueOrThrow({ where: { id: stopId } });
  expect(reverted.arrivedAt).toBeNull();
  expect(await db.operationEvent.count({ where: { stopId, type: 'ARRIVAL_REVERTED' } })).toBe(1);
  expect(await db.operationEvent.count({ where: { stopId, type: 'ARRIVAL_CONFIRMED' } })).toBe(1);

  for (const minute of [4, 5, 6, 7, 8]) await feed(minute, north(100), true);
  expect((await db.stop.findUniqueOrThrow({ where: { id: stopId } })).arrivedAt).toBeNull();

  await feed(9, north(3000), false);
  for (const minute of [10, 11, 12, 13]) await feed(minute, north(80), true);
  expect((await db.stop.findUniqueOrThrow({ where: { id: stopId } })).arrivedAt).toEqual(at(10));
});

it('only suggests the arrival when automatic arrival is switched off', async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'AUTO-OFF', licensePlate: 'B-AUTO-OFF' } });
  const tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const tour = await tours.createTour({ vehicleId: vehicle.id, orderNumber: 'ORD-OFF', stops: [
    { sequence: 1, type: 'LOAD', address: 'Berlin', city: 'Berlin', ...BERLIN },
    { sequence: 2, type: 'UNLOAD', address: 'Hamburg', city: 'Hamburg', ...HAMBURG }
  ] });
  for (const minute of [0, 1, 2, 3]) {
    await service.applyPosition({ objectUid: 'wf-off', objectNo: 'AUTO-OFF', ...north(100), standstill: true, recordedAt: at(minute) }, new Date(at(minute).getTime() + 30_000));
  }
  expect((await db.stop.findUniqueOrThrow({ where: { id: tour.stops[0].id } })).arrivedAt).toBeNull();
  expect(await db.notification.count({ where: { stopId: tour.stops[0].id, type: 'PREDICTED_ARRIVAL' } })).toBe(1);
});

it('does not date the arrival before the leg started', async () => {
  const { tour, feed, operations, tours } = await arrivalScenario('AUTO-LEG');
  await operations.confirmArrival(tour.stops[0].id, at(0), at(0), { role: 'dispatcher', sessionId: 's1' });
  await tours.recordLoaded(tour.stops[0].id, at(20));
  const hamburg = (meters: number) => ({ latitude: HAMBURG.latitude + meters / 111_000, longitude: HAMBURG.longitude });
  for (const minute of [18, 19, 20, 21, 22, 23]) await feed(minute, hamburg(100), true);
  expect((await db.stop.findUniqueOrThrow({ where: { id: tour.stops[1].id } })).arrivedAt).toEqual(at(20));
});

it('keeps the arrival pending when either point is faster than 20 km/h', async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'FAST', licensePlate: 'B-FAST 1' } });
  const tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const tour = await tours.createTour({
    vehicleId: vehicle.id,
    orderNumber: 'WF-FAST',
    stops: [
      { sequence: 1, type: 'LOAD', address: 'Berlin', latitude: 52.52, longitude: 13.405 },
      { sequence: 2, type: 'UNLOAD', address: 'Potsdam', latitude: 52.39, longitude: 13.06 }
    ]
  });
  await service.applyPosition({ objectUid: 'wf-fast', objectNo: 'FAST', latitude: 52.5201, longitude: 13.4051, speedKmh: 25, recordedAt: at(3) }, at(4));
  const result = await service.applyPosition({ objectUid: 'wf-fast', objectNo: 'FAST', latitude: 52.5202, longitude: 13.4052, speedKmh: 5, recordedAt: at(4) }, at(5));
  expect(result.arrivalConfirmed).toBe(false);
  expect((await db.stop.findUniqueOrThrow({ where: { id: tour.stops[0].id } })).arrivedAt).toBeNull();
});

describe('leaving a stop without BELADEN/ENTLADEN', () => {
  async function arrived(name: string) {
    const scenario = await arrivalScenario(name);
    for (const minute of [0, 1, 2, 3]) await scenario.feed(minute, north(100), true);
    expect((await db.stop.findUniqueOrThrow({ where: { id: scenario.stopId } })).arrivedAt).toEqual(at(0));
    const departures = () => db.notification.findMany({ where: { stopId: scenario.stopId, type: 'STOP_DEPARTED' }, orderBy: { createdAt: 'asc' } });
    return { ...scenario, departures };
  }

  it('asks once, timed at the last point inside the zone', async () => {
    const { feed, departures } = await arrived('DEP-1');
    for (const minute of [4, 5, 6]) await feed(minute, north(120), true);
    await feed(7, north(1200), false);
    expect(await departures()).toHaveLength(0);
    await feed(8, north(2500), false);
    const found = await departures();
    expect(found).toHaveLength(1);
    expect(JSON.parse(found[0].payloadJson!)).toMatchObject({ stopType: 'LOAD', leftAt: at(6).toISOString() });
    expect(found[0].message).toContain('без BELADEN');
    await feed(9, north(4000), false);
    expect(await departures()).toHaveLength(1);
  });

  it('ignores GPS jitter at the edge of the zone and stale positions', async () => {
    const { feed, departures } = await arrived('DEP-2');
    for (const minute of [4, 5, 6]) await feed(minute, north(600), false);
    expect(await departures()).toHaveLength(0);
    for (const minute of [7, 8]) await feed(minute, north(3000), false, 10 * 60);
    expect(await departures()).toHaveLength(0);
  });

  it('after «will come back» stays quiet until the truck re-enters and leaves again', async () => {
    const { feed, departures, operations, stopId } = await arrived('DEP-3');
    await feed(4, north(2000), false);
    await feed(5, north(3000), false);
    expect(await departures()).toHaveLength(1);
    await operations.keepAfterDeparture(stopId, new Date(at(5).getTime() + 40_000), { role: 'dispatcher', sessionId: 's1' });
    expect((await departures())[0].acknowledgedAt).not.toBeNull();
    for (const minute of [6, 7]) await feed(minute, north(3500), false);
    expect(await departures()).toHaveLength(1);
    await feed(10, north(100), true);
    await feed(11, north(2000), false);
    await feed(12, north(3000), false);
    expect(await departures()).toHaveLength(2);
  });

  it('closes the question once BELADEN is recorded at the departure time, or the arrival is reverted', async () => {
    const one = await arrived('DEP-4');
    await one.feed(4, north(2000), false);
    await one.feed(5, north(3000), false);
    const [question] = await one.departures();
    await one.tours.recordLoaded(one.stopId, new Date(JSON.parse(question.payloadJson!).leftAt));
    expect((await db.stop.findUniqueOrThrow({ where: { id: one.stopId } })).completedAt).toEqual(at(3));
    expect((await one.departures())[0].acknowledgedAt).not.toBeNull();

    const two = await arrived('DEP-5');
    await two.feed(4, north(2000), false);
    await two.feed(5, north(3000), false);
    await two.operations.revertArrival(two.stopId, new Date(at(5).getTime() + 40_000), { role: 'dispatcher', sessionId: 's1' });
    expect((await two.departures())[0].acknowledgedAt).not.toBeNull();
  });

  it('a fast first point outside is enough', async () => {
    const { departures, stopId } = await arrived('DEP-6');
    const service = new WebfleetTelemetryService(db as unknown as PostgresPrismaClient);
    await service.applyPosition({ objectUid: 'wf-DEP-6', objectNo: 'DEP-6', ...north(1500), standstill: false, speedKmh: 55, recordedAt: at(4) }, new Date(at(4).getTime() + 20_000));
    expect(await departures()).toHaveLength(1);
    expect(stopId).toBeTruthy();
  });
});

it('uses a geodesic radius close to one kilometre', () => {
  expect(distanceMeters(52.52, 13.405, 52.529, 13.405)).toBeGreaterThan(990);
  expect(distanceMeters(52.52, 13.405, 52.529, 13.405)).toBeLessThan(1020);
});

it('parses the official report fields and rejects non-current position statuses', () => {
  expect(parseWebfleetObjectRow({
    objectuid: 'obj-1', objectno: '125', licenseplate: 'GÖ-FX 125', status: 'A',
    latitude_mdeg: '52520000', longitude_mdeg: '13405000', pos_time: '2026-10-13T10:00:00Z',
    ignition: '1', standstill: '0', speed: '999'
  })).toMatchObject({ objectUid: 'obj-1', latitude: 52.52, longitude: 13.405, ignitionOn: true, standstill: false, speedKmh: null });
  for (const status of ['V', 'L', '0']) expect(parseWebfleetObjectRow({
    objectuid: 'obj-1', status, latitude_mdeg: '52520000', longitude_mdeg: '13405000', pos_time: '2026-10-13T10:00:00Z'
  })).toBeNull();
  expect(parseWebfleetObjectRow({
    objectuid: 'obj-1', status: 'A', latitude_mdeg: '52520000', longitude_mdeg: '13405000'
  })).toBeNull();
});

const config = { baseUrl: 'https://csv.webfleet.com/extern', account: 'acc', apiKey: 'key', username: 'user', password: 'secret' };
const jsonResponse = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });

it('classifies Webfleet JSON errors without keeping the provider message', async () => {
  const quota = fetchObjectReport(config, async () => jsonResponse({ errorCode: 8011, errorMsg: 'request quota reached' }));
  await expect(quota).rejects.toMatchObject({ category: 'RATE_LIMIT', providerCode: 8011 });
  const auth = fetchObjectReport(config, async () => jsonResponse({ errorCode: 1101, errorMsg: 'Authentication failed for user' }));
  await expect(auth).rejects.toMatchObject({ category: 'AUTH', providerCode: 1101 });
  await expect(fetchObjectReport(config, async () => new Response('nope', { status: 403 }))).rejects.toMatchObject({ category: 'PERMISSION' });
  await expect(fetchObjectReport(config, async () => { throw new TypeError('fetch failed'); })).rejects.toMatchObject({ category: 'NETWORK' });
  await expect(fetchObjectReport({ ...config, baseUrl: 'https://evil.example/extern' }, async () => jsonResponse([]))).rejects.toMatchObject({ category: 'CONFIG' });
  const error = await fetchObjectReport(config, async () => jsonResponse({ errorCode: 1101, errorMsg: 'Authentication failed for user acc' })).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(WebfleetError);
  expect(String((error as Error).message)).not.toContain('acc');
});

it('sends credentials only via Basic auth header and apikey parameter to csv.webfleet.com', async () => {
  let seen: { url: URL; init?: RequestInit } | null = null;
  const rows = await fetchObjectReport(config, async (input, init) => {
    seen = { url: new URL(String(input)), init };
    return jsonResponse([{ objectuid: 'o-1', objectno: '125', status: 'A', latitude_mdeg: 51600000, longitude_mdeg: 9950000, pos_time: '2026-10-13T10:00:00Z' }]);
  });
  expect(rows).toHaveLength(1);
  expect(seen!.url.hostname).toBe('csv.webfleet.com');
  expect(seen!.url.searchParams.get('action')).toBe('showObjectReportExtern');
  expect(seen!.url.searchParams.get('lang')).toBe('de');
  expect(seen!.url.searchParams.has('password')).toBe(false);
  expect((seen!.init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('user:secret').toString('base64')}`);
});

it('backs off for 30 minutes after an authentication failure and exposes only the category', async () => {
  const sync = new WebfleetSyncService(db as unknown as PostgresPrismaClient, config, async () => { throw new WebfleetError('AUTH', 1101); });
  const now = at(30);
  const result = await sync.refreshIfDue(now);
  expect(result).toMatchObject({ refreshed: false, reason: 'SYNC_FAILED', errorCategory: 'AUTH' });
  const status = await sync.status();
  expect(status).toMatchObject({ lastError: 'SYNC_FAILED', errorCategory: 'AUTH', providerErrorCode: 1101 });
  expect(new Date(String(status.retryAfter)).getTime() - now.getTime()).toBe(30 * 60_000);
  expect(JSON.stringify(status)).not.toContain('secret');
});

it('binds an unmatched object manually, then matches it on the next snapshot', async () => {
  await db.integrationSyncState.deleteMany({ where: { id: 'WEBFLEET:SNAPSHOT' } });
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'LKW 77', licensePlate: 'GÖ-OP 77' } });
  const freshAt = new Date(Date.now() - 60_000);
  const report = async () => [{ objectUid: 'wf-manual', objectNo: 'Truck seventy-seven', licensePlate: null, latitude: 51.6, longitude: 9.95, standstill: false, recordedAt: freshAt }];
  const sync = new WebfleetSyncService(db as unknown as PostgresPrismaClient, config, report);
  await sync.refreshIfDue();
  expect((await sync.status()).summary).toMatchObject({ matched: 0, unmatched: [{ objectUid: 'wf-manual' }] });

  const dbClient = db as unknown as PostgresPrismaClient;
  await bindWebfleetObject(dbClient, { objectUid: 'wf-manual', vehicleId: vehicle.id, objectNo: 'Truck seventy-seven' });
  await sync.forgetUnmatched('wf-manual');
  expect((await sync.status()).summary).toMatchObject({ unmatched: [] });
  expect(await listWebfleetBindings(dbClient)).toEqual(expect.arrayContaining([expect.objectContaining({ vehicleId: vehicle.id, objectUid: 'wf-manual' })]));

  const other = await db.vehicle.create({ data: { vehicleNumber: 'LKW 78' } });
  await expect(bindWebfleetObject(dbClient, { objectUid: 'wf-manual', vehicleId: other.id })).rejects.toMatchObject({ statusCode: 409 });
  await expect(bindWebfleetObject(dbClient, { objectUid: 'wf-other', vehicleId: vehicle.id })).rejects.toMatchObject({ statusCode: 409 });

  const matched = await matchWebfleetObject(dbClient, { objectUid: 'wf-manual' });
  expect(matched).toMatchObject({ vehicleId: vehicle.id, matchedBy: 'integration' });

  await unbindWebfleetVehicle(dbClient, vehicle.id);
  expect(await matchWebfleetObject(dbClient, { objectUid: 'wf-manual', objectNo: 'Truck seventy-seven' })).toMatchObject({ vehicleId: null });
  expect(await db.vehicleTelemetry.count({ where: { externalId: 'wf-manual' } })).toBe(0);
});

it('keeps syncing the fleet when one Webfleet object fails', async () => {
  await db.integrationSyncState.deleteMany({ where: { id: 'WEBFLEET:SNAPSHOT' } });
  const freshAt = new Date(Date.now() - 60_000);
  const report = async () => [
    { objectUid: 'wf-broken', objectNo: 'broken', licensePlate: null, latitude: 51.6, longitude: 9.95, standstill: false, recordedAt: freshAt },
    { objectUid: 'wf-fine', objectNo: 'fine', licensePlate: null, latitude: 51.6, longitude: 9.95, standstill: false, recordedAt: freshAt }
  ];
  const original = WebfleetTelemetryService.prototype.applyPosition;
  const spy = vi.spyOn(WebfleetTelemetryService.prototype, 'applyPosition').mockImplementation(async function (this: WebfleetTelemetryService, position, receivedAt) {
    if (position.objectUid === 'wf-broken') throw new Error('bad row');
    return original.call(this, position, receivedAt);
  });
  try {
    const sync = new WebfleetSyncService(db as unknown as PostgresPrismaClient, config, report);
    expect(await sync.refreshIfDue()).toMatchObject({ refreshed: true, received: 2 });
    expect((await sync.status()).summary).toMatchObject({ failed: 1, unmatched: [{ objectUid: 'wf-fine' }] });
  } finally { spy.mockRestore(); }
});
