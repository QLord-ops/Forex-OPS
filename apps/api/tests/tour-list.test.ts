import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { enrichTour, findToursForList, TourService, withoutDrawnRoute } from '../src/services/tours.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;
let tours: TourService;
const NOW = new Date('2026-11-10T12:00:00Z');
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-tour-list-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
  tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function tour(vehicleNumber: string, orderNumber: string) {
  const vehicle = await db.vehicle.upsert({ where: { vehicleNumber }, update: {}, create: { vehicleNumber } });
  return tours.createTour({ vehicleId: vehicle.id, orderNumber, stops: [
    { sequence: 1, type: 'LOAD', address: 'berlin', city: 'berlin', latitude: 52.52, longitude: 13.405 },
    { sequence: 2, type: 'UNLOAD', address: 'hamburg', city: 'hamburg', latitude: 53.55, longitude: 9.99 }
  ] });
}

it('the list is read and sent without the drawn route of any leg, and ETA still works', async () => {
  const created = await tour('L1', 'LIST-1');
  // A real route is hundreds of kilobytes per leg.
  await db.leg.updateMany({ where: { tourId: created.id }, data: { routeGeometry: JSON.stringify(Array.from({ length: 5_000 }, (_, i) => [9 + i / 1e4, 52 + i / 1e4])), routeDetails: 'x'.repeat(200_000) } });

  const list = await findToursForList(asAppDatabase(db), {}, NOW);
  const found = list.find((item) => item.id === created.id)!;
  expect(found.legs.length).toBeGreaterThan(0);
  expect(found.legs.every((leg) => leg.routeGeometry === '' && leg.routeDetails === null && leg.drivePlan)).toBe(true);
  expect(found.stops).toHaveLength(2);

  const sent = withoutDrawnRoute(enrichTour(found, NOW));
  expect(sent.legs.every((leg) => !('routeGeometry' in leg) && !('routeDetails' in leg) && 'eta' in leg)).toBe(true);
  expect(JSON.stringify(sent).length).toBeLessThan(20_000);
  // The tour itself keeps its route for the map.
  expect((await db.leg.findFirstOrThrow({ where: { tourId: created.id } })).routeGeometry.length).toBeGreaterThan(50_000);
});

it('running and queued tours are always listed; finished ones only for 30 days', async () => {
  const running = await tour('L2', 'LIST-RUNNING');
  const fresh = await tour('L3', 'LIST-DONE-FRESH');
  const old = await tour('L4', 'LIST-DONE-OLD');
  const cancelled = await tour('L5', 'LIST-CANCELLED-OLD');
  await db.$executeRaw`UPDATE "Tour" SET "status" = 'COMPLETED', "updatedAt" = ${day(-3)} WHERE "id" = ${fresh.id}`;
  await db.$executeRaw`UPDATE "Tour" SET "status" = 'COMPLETED', "updatedAt" = ${day(-45)} WHERE "id" = ${old.id}`;
  await db.$executeRaw`UPDATE "Tour" SET "status" = 'CANCELLED', "updatedAt" = ${day(-31)} WHERE "id" = ${cancelled.id}`;
  await db.$executeRaw`UPDATE "Tour" SET "updatedAt" = ${day(-90)} WHERE "id" = ${running.id}`;

  const orders = (await findToursForList(asAppDatabase(db), {}, NOW)).map((item) => item.orderNumber);
  expect(orders).toEqual(expect.arrayContaining(['LIST-RUNNING', 'LIST-DONE-FRESH']));
  expect(orders).not.toContain('LIST-DONE-OLD');
  expect(orders).not.toContain('LIST-CANCELLED-OLD');

  const one = await findToursForList(asAppDatabase(db), { vehicleId: running.vehicleId }, NOW);
  expect(one.map((item) => item.orderNumber)).toEqual(['LIST-RUNNING']);
  expect(await findToursForList(asAppDatabase(db), { status: 'COMPLETED' }, NOW)).toHaveLength(1);
});
