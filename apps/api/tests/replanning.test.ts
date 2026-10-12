import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReplanningService } from '../src/services/replanning.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { migrateTestDatabase } from './test-database.js';
import { createInitialClockState } from '../src/services/vehicle-clock.js';
import { makePersistedDrivePlan } from '../src/services/tours.js';

let directory: string, db: PrismaClient;
const now = new Date('2026-10-10T10:00:00Z');
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-replan-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
});
afterEach(async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); });
async function fixture(arrived = false) {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'REPLAN', clockState: null } });
  const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: 'R1', status: 'ACTIVE' } });
  const load = await db.stop.create({ data: { tourId: tour.id, sequence: 1, type: 'LOAD', address: 'Berlin', latitude: 52.5, longitude: 13.4, completedAt: now } });
  const unload = await db.stop.create({ data: { tourId: tour.id, sequence: 2, type: 'UNLOAD', address: 'Hamburg', latitude: 53.5, longitude: 10, arrivedAt: arrived ? now : null } });
  const leg = await db.leg.create({ data: { tourId: tour.id, fromStopId: load.id, toStopId: unload.id, status: 'ACTIVE', startedAt: now, routeGeometry: JSON.stringify([load, unload]), distanceMeters: 100000, routingDurationSeconds: 3600, simulatedDurationSeconds: 3600 } });
  const routing = new MockRoutingProvider();
  const route = vi.spyOn(routing, 'calculateRoute');
  return { vehicle, tour, load, unload, leg, route, service: new ReplanningService(db, routing) };
}
const replacement = { type: 'UNLOAD' as const, address: 'Kassel', latitude: 51.3, longitude: 9.5, appointmentAt: null };
it('applies atomically without network; keeps completed stops, revision, and queue transfers', async () => {
  const f = await fixture();
  const queued = await db.tour.create({ data: { vehicleId: f.vehicle.id, orderNumber: 'R2', status: 'QUEUED', previousTourId: f.tour.id, queueIndex: 1 } });
  const next = await db.stop.create({ data: { tourId: queued.id, sequence: 1, type: 'LOAD', address: 'Bremen', latitude: 53, longitude: 8 } });
  await db.leg.create({ data: { tourId: queued.id, fromStopId: f.unload.id, toStopId: next.id, distanceMeters: 1, routingDurationSeconds: 1, simulatedDurationSeconds: 1, routeGeometry: '[]' } });
  const preview = await f.service.preview(f.tour.id, { version: 0, futureStops: [replacement] }, now);
  expect(preview.etaWindows).toHaveLength(2);
  f.route.mockClear();
  const result = await f.service.apply(f.tour.id, { previewId: preview.id, version: 0 }, now);
  expect(f.route).not.toHaveBeenCalled();
  expect(result.planVersion).toBe(1);
  expect(result.stops[0].id).toBe(f.load.id);
  expect(result.stops[0].completedAt).toEqual(now);
  const transfer = await db.leg.findFirstOrThrow({ where: { tourId: queued.id } });
  expect(transfer.fromStopId).toBe(result.stops.at(-1)!.id);
  expect(await db.routeRevision.count()).toBe(2);
  expect(await db.leg.findFirstOrThrow({ where: { tourId: f.tour.id, status: 'ACTIVE' } })).toMatchObject({ drivePlan: expect.any(String) });
  await expect(f.service.apply(f.tour.id, { previewId: preview.id, version: 0 }, now)).rejects.toMatchObject({ statusCode: 409 });
});
it('rejects new clock edits and leaves all data unchanged', async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.tour.id, { version: 0, futureStops: [replacement] }, now);
  await db.vehicle.update({ where: { id: f.vehicle.id }, data: { operationVersion: 1 } });
  await expect(f.service.apply(f.tour.id, { previewId: preview.id, version: 0 }, now)).rejects.toMatchObject({ statusCode: 409 });
  expect(await db.routeRevision.count()).toBe(0);
  expect(await db.leg.findUnique({ where: { id: f.leg.id } })).not.toBeNull();
});
it('preserves confirmed arrival and incoming leg; rejects removal', async () => {
  const f = await fixture(true);
  await expect(f.service.preview(f.tour.id, { version: 0, futureStops: [replacement] }, now)).rejects.toMatchObject({ statusCode: 409 });
  const current = { id: f.unload.id, type: 'UNLOAD' as const, address: f.unload.address, latitude: f.unload.latitude, longitude: f.unload.longitude };
  const preview = await f.service.preview(f.tour.id, { version: 0, futureStops: [current, replacement] }, now);
  await f.service.apply(f.tour.id, { previewId: preview.id, version: 0 }, now);
  expect(await db.stop.findUnique({ where: { id: f.unload.id } })).toMatchObject({ arrivedAt: now });
  expect(await db.leg.findUnique({ where: { id: f.leg.id } })).toMatchObject({ toStopId: f.unload.id });
});
it('does not delete last necessary unload or accept expired preview', async () => {
  const f = await fixture();
  await expect(f.service.preview(f.tour.id, { version: 0, futureStops: [{ ...replacement, type: 'LOAD' }] }, now)).rejects.toMatchObject({ statusCode: 409 });
  const preview = await f.service.preview(f.tour.id, { version: 0, futureStops: [replacement] }, now);
  await expect(f.service.apply(f.tour.id, { previewId: preview.id, version: 0 }, new Date(now.getTime() + 600001))).rejects.toMatchObject({ statusCode: 409 });
});
it('retains known accumulated driving and stores traversed geometry on a moving replan', async () => {
  const f = await fixture();
  const clock = createInitialClockState({ effectiveAt: now, drivingSeconds: 7200, continuousDrivingSeconds: 3600, dutySeconds: 10800 });
  await db.vehicle.update({ where: { id: f.vehicle.id }, data: { clockState: JSON.stringify(clock) } });
  await db.leg.update({ where: { id: f.leg.id }, data: { drivePlan: JSON.stringify(makePersistedDrivePlan(clock, 3600, now)) } });
  const later = new Date(now.getTime() + 600000);
  const preview = await f.service.preview(f.tour.id, { version: 0, futureStops: [replacement] }, later);
  await f.service.apply(f.tour.id, { previewId: preview.id, version: 0 }, later);
  const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: f.vehicle.id } });
  expect(JSON.parse(vehicle.clockState!).currentCycle.drivingSeconds).toBe(7800);
  const leg = await db.leg.findFirstOrThrow({ where: { tourId: f.tour.id, status: 'ACTIVE' } });
  expect(JSON.parse(leg.routeDetails!).travelledGeometry.length).toBeGreaterThan(0);
});
it('rejects an event occurring during external routing before storing a preview', async () => {
  const f = await fixture();
  const calculate = f.route.getMockImplementation();
  f.route.mockImplementationOnce(async (from, to, options) => {
    await db.stop.update({ where: { id: f.unload.id }, data: { arrivedAt: now } });
    return calculate ? calculate(from, to, options) : new MockRoutingProvider().calculateRoute(from, to);
  });
  await expect(f.service.preview(f.tour.id, { version: 0, futureStops: [replacement] }, now)).rejects.toMatchObject({ statusCode: 409 });
  expect(await db.routePreview.count()).toBe(0);
});
