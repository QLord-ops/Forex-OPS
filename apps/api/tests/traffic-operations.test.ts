import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { migrateTestDatabase } from './test-database.js';
import { TourService, makePersistedDrivePlan } from '../src/services/tours.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { NotificationService } from '../src/services/notifications.js';
import { TrafficOperationsService, trafficRefreshInterval } from '../src/services/traffic-operations.js';
import { TrafficRoutingService, PrismaTrafficQuotaStore, type TrafficRouteResult } from '../src/services/traffic-routing.js';
import { createInitialClockState } from '../src/services/vehicle-clock.js';

let db: PrismaClient;
let directory: string;
const now = new Date('2026-10-11T08:00:00Z');
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-traffic-test-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
beforeEach(async () => { await db.vehicle.deleteMany(); });

it('adapts the interval to remaining free quota and disables exhausted background budget', () => {
  expect(trafficRefreshInterval(18000, 1, now)).toBe(600);
  expect(trafficRefreshInterval(10, 30, now)).toBeGreaterThan(600);
  expect(trafficRefreshInterval(0, 30, now)).toBe(Infinity);
});

async function fixture(label: string) {
  const clock = createInitialClockState({ effectiveAt: now });
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: label, clockState: JSON.stringify(clock) } });
  const tours = new TourService(db, new MockRoutingProvider());
  const tour = await tours.createTour({ vehicleId: vehicle.id, orderNumber: label, stops: [
    { sequence: 1, type: 'LOAD', address: 'Berlin', latitude: 52.52, longitude: 13.405 },
    { sequence: 2, type: 'UNLOAD', address: 'Hamburg', latitude: 53.5511, longitude: 9.9937 }
  ] });
  await db.stop.update({ where: { id: tour.stops[0].id }, data: { completedAt: now, arrivedAt: now } });
  const leg = await db.leg.update({ where: { id: tour.legs[0].id }, data: { status: 'ACTIVE', startedAt: now,
    drivePlan: JSON.stringify(makePersistedDrivePlan(clock, tour.legs[0].simulatedDurationSeconds, now)) } });
  const route: TrafficRouteResult = {
    geometry: JSON.parse(leg.routeGeometry), distanceMeters: leg.distanceMeters, durationSeconds: leg.simulatedDurationSeconds,
    provider: 'tomtom', checkedAt: now.toISOString(), trafficDelaySeconds: 900, roadNumbers: ['A24'], instructions: [],
    alternatives: [], hasRoadClosure: false, providerStatus: 'live-traffic'
  };
  const refresh = vi.fn(async () => ({ activeRoute: route, alternatives: [] }));
  const routing = { refreshCurrentRoute: refresh, quotaStatus: async () => ({ availableForSource: 18000 }) } as unknown as TrafficRoutingService;
  const service = new TrafficOperationsService(db, tours, new NotificationService(db, tours), routing);
  return { vehicle, leg, route, refresh, service, tours };
}

it('never polls manual stops or confirmed loading/unloading; moving vehicles are refreshed', async () => {
  const f = await fixture('POLL');
  await db.vehicle.update({ where: { id: f.vehicle.id }, data: { manualStoppedAt: now } });
  await f.service.tick(now);
  expect(f.refresh).not.toHaveBeenCalled();
  await db.vehicle.update({ where: { id: f.vehicle.id }, data: { manualStoppedAt: null } });
  await db.stop.update({ where: { id: f.leg.toStopId }, data: { arrivedAt: now } });
  await f.service.tick(now);
  expect(f.refresh).not.toHaveBeenCalled();
  await db.stop.update({ where: { id: f.leg.toStopId }, data: { arrivedAt: null } });
  await f.service.tick(now);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect((await f.service.status(f.vehicle.id, now)).stale).toBe(false);
  expect(await db.notification.count({ where: { vehicleId: f.vehicle.id, type: 'TRAFFIC_DELAY' } })).toBe(1);
  // Prevent this isolated fixture being picked up by subsequent service scheduler tests.
  await db.vehicle.update({ where: { id: f.vehicle.id }, data: { manualStoppedAt: now } });
});

it('retains accepted geometry and old traffic timestamp when a refresh falls back', async () => {
  const f = await fixture('FALLBACK');
  f.route.providerStatus = 'quota-exhausted'; f.route.provider = 'osrm';
  f.route.geometry = [{ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 1 }];
  await f.service.refresh(f.vehicle.id, 'manual', now);
  const leg = await db.leg.findUniqueOrThrow({ where: { id: f.leg.id } });
  expect(leg.routeGeometry).toBe(f.leg.routeGeometry);
  const status = await f.service.status(f.vehicle.id, now);
  expect(status.stale).toBe(true); expect(status.checkedAt).toBeNull();
  expect(status.providerStatus).toBe('quota-exhausted');
});

it('does not poll vehicles during a calculated break or daily rest', async () => {
  const f = await fixture('REST');
  for (const drivingSeconds of [14400, 32400]) {
    const clock = createInitialClockState({ effectiveAt: now, drivingSeconds, continuousDrivingSeconds: drivingSeconds === 14400 ? 14400 : 3600, dutySeconds: drivingSeconds });
    await db.vehicle.update({ where: { id: f.vehicle.id }, data: { clockState: JSON.stringify(clock) } });
    await db.leg.update({ where: { id: f.leg.id }, data: { drivePlan: JSON.stringify(makePersistedDrivePlan(clock, f.leg.simulatedDurationSeconds, now)) } });
    expect((await f.tours.getCurrentPosition(f.vehicle.id, new Date(now.getTime() + 60000))).status).toBe('WAITING');
    await f.service.tick(new Date(now.getTime() + 60000));
  }
  expect(f.refresh).not.toHaveBeenCalled();
});

it('saves traffic as a revision without erasing driven prefix or accumulated hours', async () => {
  const f = await fixture('PREFIX');
  const later = new Date(now.getTime() + 600000);
  await f.service.refresh(f.vehicle.id, 'manual', later);
  const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: f.vehicle.id } });
  expect(JSON.parse(vehicle.clockState!).currentCycle.drivingSeconds).toBe(600);
  const leg = await db.leg.findUniqueOrThrow({ where: { id: f.leg.id } });
  expect(JSON.parse(leg.routeDetails!).travelledGeometry.length).toBeGreaterThan(0);
  expect(await db.routeRevision.count({ where: { tourId: f.leg.tourId } })).toBe(1);
  await expect(f.service.accept(f.vehicle.id, 0, 0)).rejects.toMatchObject({ statusCode: 409 });
});

it('persists quota across store reconstruction and refuses requests beyond the hard cap', async () => {
  const store = new PrismaTrafficQuotaStore(db, { namespace: 'integration-test', monthlyCap: 2 });
  expect((await store.consume('manual', now)).used).toBe(1);
  const restarted = new PrismaTrafficQuotaStore(db, { namespace: 'integration-test', monthlyCap: 2 });
  expect((await restarted.consume('manual', now)).used).toBe(2);
  await expect(restarted.consume('manual', now)).rejects.toMatchObject({ statusCode: 429 });
});
