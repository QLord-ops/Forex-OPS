import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { TourService } from '../src/services/tours.js';
import { distanceMeters, matchWebfleetObject, parseWebfleetObjectRow, WebfleetTelemetryService } from '../src/services/webfleet.js';
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

it('suggests arrival without changing the stop after two fresh stopped positions inside the radius', async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'AUTO-ARRIVAL', licensePlate: 'B-AA 1' } });
  const tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const tour = await tours.createTour({
    vehicleId: vehicle.id,
    orderNumber: 'WF-ARRIVAL',
    stops: [
      { sequence: 1, type: 'LOAD', address: 'Berlin', city: 'Berlin', latitude: 52.52, longitude: 13.405 },
      { sequence: 2, type: 'UNLOAD', address: 'Hamburg', city: 'Hamburg', latitude: 53.55, longitude: 9.99 }
    ]
  });
  const stop = tour.stops[0];
  const first = await service.applyPosition({
    objectUid: 'wf-arrival', objectNo: 'AUTO-ARRIVAL', latitude: 52.5205, longitude: 13.4055,
    standstill: true, recordedAt: at(0)
  }, at(1));
  expect(first.arrivalConfirmed).toBe(false);
  expect((await db.stop.findUniqueOrThrow({ where: { id: stop.id } })).arrivedAt).toBeNull();

  const second = await service.applyPosition({
    objectUid: 'wf-arrival', objectNo: 'AUTO-ARRIVAL', latitude: 52.5202, longitude: 13.4052,
    standstill: true, recordedAt: at(1)
  }, at(2));
  expect(second).toMatchObject({ arrivalConfirmed: false, arrivalSuggested: true });
  expect((await db.stop.findUniqueOrThrow({ where: { id: stop.id } })).arrivedAt).toBeNull();
  expect(await db.operationEvent.count({ where: { stopId: stop.id, type: 'ARRIVAL_CONFIRMED' } })).toBe(0);
  expect(await db.notification.count({ where: { stopId: stop.id, type: 'PREDICTED_ARRIVAL' } })).toBe(1);
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
