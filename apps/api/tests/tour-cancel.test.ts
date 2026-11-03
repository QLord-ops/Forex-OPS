import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { OperationsService } from '../src/services/operations.js';
import { TourService } from '../src/services/tours.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;
let tours: TourService;
const actor = { role: 'dispatcher' as const, sessionId: 'cancel-test' };
const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 8, minute));
const CITY = {
  berlin: { latitude: 52.52, longitude: 13.405 },
  hamburg: { latitude: 53.55, longitude: 9.99 },
  munich: { latitude: 48.137, longitude: 11.575 },
  cologne: { latitude: 50.937, longitude: 6.96 },
  leipzig: { latitude: 51.34, longitude: 12.37 }
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-tour-cancel-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
  tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function chain(name: string) {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: name } });
  const make = (order: string, from: keyof typeof CITY, to: keyof typeof CITY) => tours.createTour({ vehicleId: vehicle.id, orderNumber: order, stops: [
    { sequence: 1, type: 'LOAD', address: from, city: from, ...CITY[from] },
    { sequence: 2, type: 'UNLOAD', address: to, city: to, ...CITY[to] }
  ] });
  const first = await make(`${name}-1`, 'berlin', 'hamburg');
  const second = await make(`${name}-2`, 'munich', 'cologne');
  const third = await make(`${name}-3`, 'leipzig', 'berlin');
  return { vehicle, first, second, third };
}
const reload = (id: string) => db.tour.findUniqueOrThrow({ where: { id }, include: { stops: { orderBy: { sequence: 'asc' } }, legs: true } });

it('cancels a tour from the middle of the queue and re-links the following one', async () => {
  const { first, second, third } = await chain('MID');
  const cancelled = await tours.cancelTour(second.id, second.planVersion, at(0), actor);
  expect(cancelled.status).toBe('CANCELLED');
  const next = await reload(third.id);
  expect(next).toMatchObject({ status: 'QUEUED', previousTourId: first.id });
  const transfer = next.legs.filter((leg) => leg.toStopId === next.stops[0].id);
  expect(transfer).toHaveLength(1);
  expect(transfer[0].fromStopId).toBe(first.stops.at(-1)!.id);
  // Nothing is erased: the cancelled tour keeps its stops.
  expect((await reload(second.id)).stops).toHaveLength(2);
  expect(await db.auditLog.findFirst({ where: { tourId: second.id, action: 'TOUR_CANCELLED' } })).toMatchObject({ actorSessionId: 'cancel-test' });
});

it('cancels the current tour before the first arrival and starts the next one', async () => {
  const { first, second, third } = await chain('HEAD');
  await tours.cancelTour(first.id, undefined, at(0), actor);
  const next = await reload(second.id);
  expect(next).toMatchObject({ status: 'ACTIVE', previousTourId: null });
  // At the front of the queue a tour starts without a transfer from the cancelled one.
  expect(next.legs.some((leg) => !next.stops.some((stop) => stop.id === leg.fromStopId))).toBe(false);
  expect((await reload(third.id)).status).toBe('QUEUED');
});

it('refuses a tour that has begun and a stale version', async () => {
  const { first, second } = await chain('BEGUN');
  const operations = new OperationsService(asAppDatabase(db), tours);
  await operations.confirmArrival(first.stops[0].id, at(1), at(1), actor);
  await expect(tours.cancelTour(first.id, undefined, at(2), actor)).rejects.toThrow('Тур начат');
  await expect(tours.cancelTour(second.id, second.planVersion + 5, at(2), actor)).rejects.toThrow('Тур изменился');
  expect((await reload(first.id)).status).toBe('ACTIVE');
});

it('BELADEN without a GPS arrival records the arrival at the same moment', async () => {
  const { first } = await chain('NOGPS');
  await expect(tours.recordLoaded(first.stops[0].id, at(5), undefined, actor)).rejects.toThrow('подтвердить прибытие');
  await tours.recordLoaded(first.stops[0].id, at(5), undefined, actor, { arriveWithEvent: true });
  const stop = await db.stop.findUniqueOrThrow({ where: { id: first.stops[0].id } });
  expect(stop).toMatchObject({ arrivedAt: at(5), completedAt: at(5) });
  const event = await db.operationEvent.findFirstOrThrow({ where: { stopId: stop.id, type: 'ARRIVAL_CONFIRMED' } });
  expect(JSON.parse(event.payloadJson!)).toMatchObject({ source: 'WITH_STOP_EVENT', event: 'LOADED' });
});
