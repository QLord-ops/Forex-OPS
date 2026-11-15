import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CurrentPosition } from '../src/domain.js';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { DailyStatusService, leftPlace, type DailyStatusDeps } from '../src/services/daily-status.js';
import { EtaService } from '../src/services/eta.js';
import type { DriverHours } from '../src/services/webfleet-live.js';
import { migrateTestDatabase } from './test-database.js';

// Owner, 15.11.2026: a truck that left a stop in the morning before BELADEN/ENTLADEN was recorded heads for the next stop,
// and the morning list must show that one.
const BAUNATAL = { latitude: 51.2585, longitude: 9.4195 };
const LEERGUT = { latitude: 51.2593, longitude: 9.4203 };
const KASSEL = { latitude: 51.3127, longitude: 9.4797 };
const ON_THE_WAY = { latitude: 51.29, longitude: 9.455 };
const SEVEN = new Date('2026-11-05T06:00:00Z');
const system = { role: 'system' as const, sessionId: 'daily-status' };

let directory: string;
let db: PrismaClient;
const gps = new Map<string, { latitude: number; longitude: number; stale: boolean }>();

function deps(): DailyStatusDeps {
  return {
    // The tour service still sees the truck at the stop it arrived at: nothing was recorded since.
    getPosition: async () => ({ position: BAUNATAL, positionSource: 'WEBFLEET', telemetryStale: false, remainingDistanceMeters: 0 } as CurrentPosition),
    latestTelemetry: async (id) => { const point = gps.get(id); return point ? { address: 'A49, 34225 Baunatal, DE', ...point } : null; },
    driverHours: async () => ({ status: 'NONE', workState: null, activitySince: null, times: null, timesStatus: 'NO_DATA' } as DriverHours),
    coupledTrailerNo: async () => null,
    webfleetReady: () => true,
    eta: new EtaService(),
    startedAt: new Date('2026-11-05T00:00:00Z')
  };
}

/** Unloading and Leergut loading at the VW plant in Baunatal, then unloading in Kassel. */
async function truck(number: string, arrivedAt: Date, point: { latitude: number; longitude: number; stale: boolean } | null) {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: number, line: 'SCHNELLECKE', statusGroup: 'NORD' } });
  const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: `A-${number}`, status: 'ACTIVE' } });
  const unload = await db.stop.create({ data: { tourId: tour.id, sequence: 1, type: 'UNLOAD', address: 'Dr.-Rudolf-Leiding-Platz 1, 34225 Baunatal', city: 'Baunatal', ...BAUNATAL, arrivedAt } });
  const load = await db.stop.create({ data: { tourId: tour.id, sequence: 2, type: 'LOAD', address: 'Dr.-Rudolf-Leiding-Platz 1, 34225 Baunatal', city: 'Baunatal', ...LEERGUT } });
  const last = await db.stop.create({ data: { tourId: tour.id, sequence: 3, type: 'UNLOAD', address: 'Werkstraße 2, 34123 Kassel', city: 'Kassel', ...KASSEL } });
  await db.leg.create({ data: { tourId: tour.id, fromStopId: unload.id, toStopId: load.id, distanceMeters: 0, routeGeometry: '[]', routingDurationSeconds: 0, simulatedDurationSeconds: 0 } });
  await db.leg.create({ data: { tourId: tour.id, fromStopId: load.id, toStopId: last.id, distanceMeters: 11_000, routeGeometry: '[]', routingDurationSeconds: 1200, simulatedDurationSeconds: 1500 } });
  if (point) gps.set(vehicle.id, point);
  return { vehicle, unload, load, last };
}
const rowOf = async (number: string) => (await new DailyStatusService(db as unknown as PostgresPrismaClient, deps()).generate('2026-11-05', SEVEN, system)).rows.find((row) => row.vehicleNumber === number)!;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-daily-left-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
beforeEach(async () => { await db.dailyStatusReport.deleteMany(); });

describe('which stops the truck has left', () => {
  const stops = [
    { id: 'u', ...BAUNATAL, arrivedAt: new Date('2026-11-05T04:00:00Z'), completedAt: null },
    { id: 'l', ...LEERGUT, arrivedAt: null, completedAt: null },
    { id: 'k', ...KASSEL, arrivedAt: null, completedAt: null }
  ];
  const tours = [{ status: 'ACTIVE', stops }];

  it('the whole place, once fresh GPS is past its zone', () => {
    expect(leftPlace({ tours, gps: { ...ON_THE_WAY, stale: false }, departedStopIds: [] })).toEqual(['u', 'l']);
  });

  it('nothing while the truck is still in the zone, and nothing from stale GPS', () => {
    expect(leftPlace({ tours, gps: { latitude: 51.262, longitude: 9.42, stale: false }, departedStopIds: [] })).toEqual([]);
    expect(leftPlace({ tours, gps: { ...ON_THE_WAY, stale: true }, departedStopIds: [] })).toEqual([]);
  });

  it('the open question «уехала с точки» is proof enough, even with stale GPS', () => {
    expect(leftPlace({ tours, gps: null, departedStopIds: ['u'] })).toEqual(['u', 'l']);
  });

  it('nothing before the truck has arrived', () => {
    expect(leftPlace({ tours: [{ status: 'ACTIVE', stops: stops.map((stop) => ({ ...stop, arrivedAt: null })) }], gps: { ...ON_THE_WAY, stale: false }, departedStopIds: [] })).toEqual([]);
  });

  it('a zone the dispatcher made wider keeps the truck at the stop', () => {
    const wide = [{ status: 'ACTIVE', stops: stops.map((stop, index) => index ? stop : { ...stop, arrivalRadiusMeters: 5000 }) }];
    expect(leftPlace({ tours: wide, gps: { ...ON_THE_WAY, stale: false }, departedStopIds: [] })).toEqual([]);
  });
});

describe('the morning list after the truck left (owner, 15.11)', () => {
  it('shows the next stop with an ETA from where the truck is, and tells the dispatcher what is missing', async () => {
    const { last } = await truck('901', new Date('2026-11-05T04:10:00Z'), { ...ON_THE_WAY, stale: false });
    const row = await rowOf('901');
    expect(row).toMatchObject({ rule: 'EN_ROUTE', ziel: 'Kassel', stopId: last.id, ankunftKind: 'ETA' });
    expect(row.flags).toContain('LEFT_WITHOUT_EVENT');
    const eta = new Date(row.ankunftAt!).getTime();
    // About a third of the 25-minute leg is left; never the whole leg from the plant, never in the past.
    expect(eta).toBeGreaterThan(SEVEN.getTime());
    expect(eta).toBeLessThan(SEVEN.getTime() + 25 * 60_000);
    // Nothing is recorded on the tour: the list only looks ahead.
    expect(await db.stop.count({ where: { tour: { vehicle: { vehicleNumber: '901' } }, completedAt: { not: null } } })).toBe(0);
  });

  it('a truck that arrived yesterday and left this morning is on the way, not stuck', async () => {
    await truck('902', new Date('2026-11-04T17:40:00Z'), { ...ON_THE_WAY, stale: false });
    expect(await rowOf('902')).toMatchObject({ rule: 'EN_ROUTE', ziel: 'Kassel' });
  });

  it('the open departure question moves the list on even when GPS is stale', async () => {
    const { vehicle, unload } = await truck('903', new Date('2026-11-05T04:10:00Z'), { ...ON_THE_WAY, stale: true });
    await db.notification.create({ data: { dedupKey: 'departure:903', vehicleId: vehicle.id, stopId: unload.id, type: 'STOP_DEPARTED', message: 'LKW 903 уехала', payloadJson: '{}' } });
    expect(await rowOf('903')).toMatchObject({ rule: 'EN_ROUTE', ziel: 'Kassel' });
  });

  it('still standing at the plant, or no fresh GPS: the truck is at the stop as before', async () => {
    await truck('904', new Date('2026-11-05T04:10:00Z'), { latitude: 51.262, longitude: 9.42, stale: false });
    await truck('905', new Date('2026-11-05T04:10:00Z'), { ...ON_THE_WAY, stale: true });
    for (const number of ['904', '905']) {
      const row = await rowOf(number);
      expect(row).toMatchObject({ rule: 'AT_STOP', ziel: 'Baunatal' });
      expect(row.flags).not.toContain('LEFT_WITHOUT_EVENT');
    }
  });
});
