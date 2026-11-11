import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { CurrentPosition } from '../src/domain.js';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { NotificationService } from '../src/services/notifications.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { TourService, makePersistedDrivePlan } from '../src/services/tours.js';
import { TrafficOperationsService } from '../src/services/traffic-operations.js';
import type { TrafficRouteResult, TrafficRoutingService } from '../src/services/traffic-routing.js';
import { createInitialClockState } from '../src/services/vehicle-clock.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;
const now = new Date('2026-11-11T08:00:00Z');
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-reroute-test-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

// The truck drove from Berlin towards Hamburg and left the line near Schwerin.
const TRUCK = { latitude: 53.63, longitude: 11.41 };
const NEW_LINE = [TRUCK, { latitude: 53.6, longitude: 10.7 }, { latitude: 53.5511, longitude: 9.9937 }];

async function fixture(label: string, source: 'GPS' | 'CALCULATED' = 'GPS') {
  const clock = createInitialClockState({ effectiveAt: now });
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: label, clockState: JSON.stringify(clock) } });
  const tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const tour = await tours.createTour({ vehicleId: vehicle.id, orderNumber: label, stops: [
    { sequence: 1, type: 'LOAD', address: 'Berlin', latitude: 52.52, longitude: 13.405 },
    { sequence: 2, type: 'UNLOAD', address: 'Hamburg', latitude: 53.5511, longitude: 9.9937 }
  ] });
  await db.stop.update({ where: { id: tour.stops[0].id }, data: { completedAt: now, arrivedAt: now } });
  const leg = await db.leg.update({ where: { id: tour.legs[0].id }, data: { status: 'ACTIVE', startedAt: now,
    drivePlan: JSON.stringify(makePersistedDrivePlan(clock, tour.legs[0].simulatedDurationSeconds, now)) } });
  const route: TrafficRouteResult = {
    geometry: NEW_LINE, distanceMeters: 110_000, durationSeconds: 5_400, provider: 'tomtom', checkedAt: now.toISOString(),
    trafficDelaySeconds: 0, roadNumbers: ['A24', 'A1', 'B5'], mainRoads: ['A24', 'A1'], instructions: [], alternatives: [], hasRoadClosure: false, providerStatus: 'live-traffic'
  };
  const refresh = vi.fn(async (_input: { origin: unknown; options?: unknown; supportingPoints?: unknown }) => ({ activeRoute: route, alternatives: [] }));
  const routing = { refreshCurrentRoute: refresh, quotaStatus: async () => ({ availableForSource: 18000 }) } as unknown as TrafficRoutingService;
  const getPosition = vi.fn(async () => ({ etaSource: source, status: 'MOVING', position: source === 'GPS' ? TRUCK : null, offRouteMeters: 3_400, legId: leg.id,
    eta: '2026-11-11T12:50:00.000Z', remainingDistanceMeters: 120_000, travelledGeometry: [[13.405, 52.52], [12.4, 53.1], [11.41, 53.63]], remainingGeometry: [[11.41, 53.63], [9.9937, 53.5511]] } as unknown as CurrentPosition));
  const service = new TrafficOperationsService(asAppDatabase(db), tours, new NotificationService(asAppDatabase(db), tours), routing, getPosition);
  return { vehicle, tour, leg, route, refresh, service };
}

it('rebuilds the route from the GPS position and records it as an automatic change', async () => {
  const f = await fixture('AUTO');
  const result = await f.service.rerouteFromGps(f.vehicle.id, now);
  expect(result).toMatchObject({ distanceMeters: 110_000, mainRoads: ['A24', 'A1'], live: true, previousEta: '2026-11-11T12:50:00.000Z' });
  // The new line starts at the truck and is planned afresh, not along the old one.
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.refresh.mock.calls[0]![0]).toMatchObject({ origin: TRUCK, options: { source: 'background' } });
  expect(f.refresh.mock.calls[0]![0]).not.toHaveProperty('supportingPoints');

  const leg = await db.leg.findUniqueOrThrow({ where: { id: f.leg.id } });
  expect(JSON.parse(leg.routeGeometry)).toEqual(NEW_LINE);
  expect(leg.distanceMeters).toBe(110_000);
  const details = JSON.parse(leg.routeDetails ?? '{}');
  expect(details.autoReroutedAt).toBe(now.toISOString());
  // What was really driven stays on the map.
  expect(details.travelledGeometry.at(-1)).toEqual(TRUCK);

  expect((await db.tour.findUniqueOrThrow({ where: { id: f.tour.id } })).planVersion).toBe(f.tour.planVersion + 1);
  expect(await db.routeRevision.count({ where: { tourId: f.tour.id } })).toBe(1);
  expect(await db.operationEvent.findFirst({ where: { vehicleId: f.vehicle.id, type: 'ROUTE_REBUILT_AUTO' } })).not.toBeNull();
  expect(await db.auditLog.findFirst({ where: { vehicleId: f.vehicle.id, action: 'ROUTE_REBUILT_AUTO' } })).toMatchObject({ actorRole: 'system', actorSessionId: 'route-deviation' });
});

it('rebuilds at most once in ten minutes for a leg', async () => {
  const f = await fixture('LIMIT');
  expect(await f.service.rerouteFromGps(f.vehicle.id, now)).not.toBeNull();
  expect(await f.service.rerouteFromGps(f.vehicle.id, later(5))).toBeNull();
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(await f.service.rerouteFromGps(f.vehicle.id, later(11))).not.toBeNull();
});

it('a route without live traffic is still applied and said to be so', async () => {
  const f = await fixture('NOTRAFFIC');
  f.route.providerStatus = 'quota-exhausted'; f.route.provider = 'osrm';
  expect(await f.service.rerouteFromGps(f.vehicle.id, now)).toMatchObject({ live: false, distanceMeters: 110_000 });
  expect(JSON.parse((await db.leg.findUniqueOrThrow({ where: { id: f.leg.id } })).routeGeometry)).toEqual(NEW_LINE);
});

it('changes nothing without fresh GPS, on the stop, or when no route came back', async () => {
  const calculated = await fixture('CALC', 'CALCULATED');
  expect(await calculated.service.rerouteFromGps(calculated.vehicle.id, now)).toBeNull();
  expect(calculated.refresh).not.toHaveBeenCalled();

  const arrived = await fixture('ARRIVED');
  await db.stop.update({ where: { id: arrived.leg.toStopId }, data: { arrivedAt: now } });
  expect(await arrived.service.rerouteFromGps(arrived.vehicle.id, now)).toBeNull();
  expect(arrived.refresh).not.toHaveBeenCalled();

  const empty = await fixture('EMPTY');
  empty.route.geometry = []; empty.route.distanceMeters = 0;
  expect(await empty.service.rerouteFromGps(empty.vehicle.id, now)).toBeNull();
  expect((await db.leg.findUniqueOrThrow({ where: { id: empty.leg.id } })).routeGeometry).toBe(empty.leg.routeGeometry);
  expect(await db.operationEvent.count({ where: { vehicleId: empty.vehicle.id, type: 'ROUTE_REBUILT_AUTO' } })).toBe(0);
});
