import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { parseWebfleetObjectRow, WebfleetError, WebfleetTelemetryService, type WebfleetReadAction } from '../src/services/webfleet.js';
import {
  buildVehicleCard, DRIVING_TIMES_INTERVAL_MS, parseDrivingTimesRow, parseVehicleReportRow, suggestWebfleetBindings,
  VEHICLE_REPORT_INTERVAL_MS, WebfleetDetailsSync, WebfleetLiveStore
} from '../src/services/webfleet-live.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;
const pg = () => db as unknown as PostgresPrismaClient;
const config = { baseUrl: 'https://csv.webfleet.com/extern', account: 'acc', apiKey: 'key', username: 'user', password: 'secret' };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-webfleet-live-test-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const objectRow = {
  objectuid: 'obj-2868', objectno: 'B CY 2868', objectclassname: 'Fahrzeug', objecttype: 'truck_with_trailer', status: 'A',
  latitude_mdeg: 51600000, longitude_mdeg: 9950000, pos_time: '2026-11-03T07:00:00Z',
  speed: '84', course: '45', postext: 'Kurt-Nagel-Straße, 33829 Borgholzhausen, DE',
  fuellevel: '824', odometer: '1961867', odometer_long: '196186700', engine_operating_time: '12279240',
  ignition: '1', ignition_time: '2026-11-03T05:47:21Z', standstill: '0',
  driveruid: 'drv-1', drivername: 'Max Mustermann', driver_currentworkstate: '5'
};

describe('object report', () => {
  it('reads vehicle facts in the documented units', () => {
    expect(parseWebfleetObjectRow(objectRow)).toMatchObject({
      speedKmh: 84, courseDeg: 45, address: 'Kurt-Nagel-Straße, 33829 Borgholzhausen, DE',
      fuelPercent: 82.4, odometerKm: 196186.7, engineHours: 3410.9, ignitionChangedAt: '2026-11-03T05:47:21.000Z',
      objectType: 'truck_with_trailer', isTrailer: false,
      driver: { driverUid: 'drv-1', name: 'Max Mustermann', workState: 5 }
    });
    expect(parseWebfleetObjectRow({ ...objectRow, objectclassname: 'Anhänger', driveruid: undefined, drivername: undefined })).toMatchObject({ isTrailer: true, driver: null });
  });

  it('stores truck facts but never the driver in telemetry history', async () => {
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'B CY 2868' } });
    const position = parseWebfleetObjectRow(objectRow)!;
    const service = new WebfleetTelemetryService(pg());
    await service.applyPosition(position, new Date('2026-11-03T07:01:00Z'));
    const stored = await db.vehicleTelemetry.findFirstOrThrow({ where: { vehicleId: vehicle.id } });
    expect(stored.speedKmh).toBe(84);
    expect(stored.rawJson).toContain('82.4');
    expect(stored.rawJson).not.toContain('Mustermann');
    expect(stored.rawJson).not.toContain('drv-1');
    expect(await service.latest(vehicle.id, new Date('2026-11-03T07:01:00Z'))).toMatchObject({ fuelPercent: 82.4, courseDeg: 45, address: expect.stringContaining('Borgholzhausen') });
  });
});

describe('driving times and vehicle report', () => {
  it('converts tachograph rows and vehicle master data', () => {
    expect(parseDrivingTimesRow({
      driveruid: 'drv-1', drivername: 'Max Mustermann', reference_time: '2026-11-03T07:42:00Z',
      remain_driving_today: 22980000, max_driving_today: 36000000, current_shift_start: '2026-11-03T05:21:00Z',
      latest_end_current_shift: '2026-11-03T20:21:00Z', next_break: 8100000, next_break_min_duration: 2700000,
      extended_shifts: 1, max_extended_shifts: 2, infringements: false
    })).toMatchObject({ driverUid: 'drv-1', remainDrivingTodayMs: 22980000, maxDrivingTodayMs: 36000000, shiftStartedAt: '2026-11-03T05:21:00.000Z', extendedShiftsLeft: 1, infringements: false });
    expect(parseDrivingTimesRow({ drivername: 'no uid' })).toBeNull();
    expect(parseVehicleReportRow({ objectuid: 'obj-2868', licenseplatenumber: 'B CY 2868', identnumber: 'W1T96340710771379', fueltanksize: 890 }))
      .toEqual({ objectUid: 'obj-2868', plate: 'B CY 2868', vin: 'W1T96340710771379', tankLiters: 890 });
  });

  it('asks for extra reports only after a successful position snapshot and on their own intervals', async () => {
    const store = new WebfleetLiveStore();
    const request = vi.fn(async (_config: unknown, action: WebfleetReadAction) => action === 'getRemainingDrivingTimesEU'
      ? [{ driveruid: 'drv-1', remain_driving_today: 1000 }]
      : [{ objectuid: 'obj-2868', licenseplatenumber: 'B CY 2868' }]);
    const sync = new WebfleetDetailsSync(store, config, request);
    const start = new Date('2026-11-03T07:00:00Z');

    await sync.refreshIfDue(start);
    expect(request).not.toHaveBeenCalled();

    store.setObjects([], start);
    await sync.refreshIfDue(start);
    expect(request.mock.calls.map((call) => call[1])).toEqual(['getRemainingDrivingTimesEU', 'showVehicleReportExtern']);
    expect(store.drivingTimes('drv-1')).toMatchObject({ remainDrivingTodayMs: 1000 });

    const later = new Date(start.getTime() + DRIVING_TIMES_INTERVAL_MS);
    store.setObjects([], later);
    await sync.refreshIfDue(later);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][1]).toBe('getRemainingDrivingTimesEU');

    const hourLater = new Date(start.getTime() + VEHICLE_REPORT_INTERVAL_MS);
    store.setObjects([], hourLater);
    await sync.refreshIfDue(hourLater);
    expect(request.mock.calls.slice(3).map((call) => call[1])).toEqual(['getRemainingDrivingTimesEU', 'showVehicleReportExtern']);
  });

  it('pauses a failing report without touching the other one', async () => {
    const store = new WebfleetLiveStore();
    const request = vi.fn(async (_config: unknown, action: WebfleetReadAction) => {
      if (action === 'getRemainingDrivingTimesEU') throw new WebfleetError('PERMISSION', 55);
      return [{ objectuid: 'obj-2868', fueltanksize: 890 }];
    });
    const sync = new WebfleetDetailsSync(store, config, request);
    const now = new Date('2026-11-03T07:00:00Z');
    store.setObjects([], now);
    await sync.refreshIfDue(now);
    expect(store.drivingFeed).toMatchObject({ error: 'PERMISSION', providerCode: 55, nextAt: now.getTime() + 30 * 60_000 });
    expect(store.vehicleInfo('obj-2868')).toMatchObject({ tankLiters: 890 });

    const soon = new Date(now.getTime() + 6 * 60_000);
    store.setObjects([], soon);
    await sync.refreshIfDue(soon);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('vehicle card', () => {
  it('combines stored truck facts with the live driver and tachograph', async () => {
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: '2868-card' } });
    await db.vehicleIntegration.create({ data: { vehicleId: vehicle.id, provider: 'WEBFLEET', externalId: 'obj-card', externalNumber: 'B CY 2868' } });
    const now = new Date('2026-11-03T07:01:00Z');
    const store = new WebfleetLiveStore();
    const latest = async () => ({
      recordedAt: new Date('2026-11-03T07:00:00Z'), ageSeconds: 60, stale: false, usable: true, latitude: 51.6, longitude: 9.95,
      speedKmh: 84, ignitionOn: true, standstill: false, courseDeg: 45, address: 'A7', fuelPercent: 82.4, odometerKm: 196186.7,
      engineHours: 3410.9, ignitionChangedAt: '2026-11-03T05:47:21.000Z', objectType: 'truck_with_trailer'
    });

    const waiting = await buildVehicleCard(pg(), store, latest, vehicle.id, now);
    expect(waiting.driver).toEqual({ status: 'WAITING' });

    store.setObjects([{ ...parseWebfleetObjectRow(objectRow)!, objectUid: 'obj-card' }], now);
    store.setVehicles([{ objectUid: 'obj-card', plate: 'B CY 2868', vin: 'VIN', tankLiters: 890 }], now);
    store.setDrivingTimes([parseDrivingTimesRow({ driveruid: 'drv-1', remain_driving_today: 22980000, max_driving_today: 36000000 })!], now);
    const card = await buildVehicleCard(pg(), store, latest, vehicle.id, now);
    expect(card.webfleet).toMatchObject({ objectNo: 'B CY 2868', plate: 'B CY 2868', tankLiters: 890 });
    expect(card.current).toMatchObject({ speedKmh: 84, fuelPercent: 82.4, fuelLiters: 733, coordinate: [9.95, 51.6] });
    expect(card.driver).toMatchObject({ status: 'SIGNED_ON', name: 'Max Mustermann', workState: 5, drivingTimesStatus: 'OK', drivingTimes: { remainDrivingTodayMs: 22980000 } });

    const muchLater = new Date(now.getTime() + 10 * 60_000);
    expect((await buildVehicleCard(pg(), store, latest, vehicle.id, muchLater)).driver).toEqual({ status: 'WAITING' });
  });

  it('shows an unbound truck without Webfleet data and rejects unknown trucks', async () => {
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'unbound-card' } });
    const card = await buildVehicleCard(pg(), new WebfleetLiveStore(), async () => null, vehicle.id);
    expect(card).toMatchObject({ webfleet: null, current: null, driver: null });
    await expect(buildVehicleCard(pg(), new WebfleetLiveStore(), async () => null, 'missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('binding suggestions', () => {
  it('proposes exact plates first and bare numbers only when both sides are unique', async () => {
    const exact = await db.vehicle.create({ data: { vehicleNumber: 'B-CY3786' } });
    await db.vehicle.create({ data: { vehicleNumber: '3786' } });
    const bare = await db.vehicle.create({ data: { vehicleNumber: '7448' } });
    await db.vehicle.create({ data: { vehicleNumber: '1139' } });
    const suggestions = await suggestWebfleetBindings(pg(), [
      { objectUid: 'o-3786', objectNo: 'B CY 3786' },
      { objectUid: 'o-7448', objectNo: 'GÖ FX 7448' },
      { objectUid: 'o-1139a', objectNo: 'B CY 1139' },
      { objectUid: 'o-1139b', objectNo: 'GÖ FX 1139' },
      { objectUid: 'o-trailer', objectNo: 'GÖ FX 7448', isTrailer: true }
    ]);
    expect(suggestions).toEqual([
      expect.objectContaining({ objectUid: 'o-3786', vehicleId: exact.id, reason: 'EXACT' }),
      expect.objectContaining({ objectUid: 'o-7448', vehicleId: bare.id, reason: 'NUMBER' })
    ]);
  });
});
