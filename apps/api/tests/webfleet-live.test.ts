import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { parseWebfleetObjectRow, WebfleetError, WebfleetTelemetryService, type WebfleetReadAction } from '../src/services/webfleet.js';
import {
  buildVehicleCard, parseDriverActivityRow, parseDrivingTimesRow, parseEventRow, parseTripRow, parseVehicleReportRow,
  SLOW_REPORT_GAP_MS, suggestWebfleetBindings, WebfleetDetailsSync, WebfleetLiveStore, WebfleetTrackService
} from '../src/services/webfleet-live.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;
const pg = () => db as unknown as PostgresPrismaClient;
const config = { baseUrl: 'https://csv.webfleet.com/extern', account: 'acc', apiKey: 'key', username: 'user', password: 'secret' };
const MIN = 60_000;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-webfleet-live-test-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

// Real WEBFLEET.connect rows for B CY 2803 on 03.11.2026, the truck on the dispatcher's Webfleet screenshot.
const objectRow = {
  objectuid: 'obj-test-1', objectno: 'B CY 2803', objectname: 'MB', objectclassname: 'Fahrzeug', objecttype: 'heavy_truck', status: 'A',
  latitude_mdeg: 51410002, longitude_mdeg: 11681596, pos_time: '2026-11-03T08:54:17Z', postext: '06268 Obhausen, DE',
  speed: '84', course: '121', fuellevel: '150', odometer: '15669', odometer_long: '1566900', engine_operating_time: '120060',
  ignition: '1', ignition_time: '2026-11-03T07:05:09Z', standstill: '0', tripmode: '2',
  driveruid: 'drv-test-1', drivername: 'Max Mustermann', driver_currentworkstate: '5'
};
const drivingRow = {
  driveruid: 'drv-test-1', drivername: 'Max Mustermann', reference_time: '2026-11-03T08:52:00Z',
  next_break: 4_440_000, next_break_min_duration: 1_800_000, next_rest: 34_740_000, next_rest_min_duration: 32_400_000,
  remain_driving_today: 24_360_000, max_driving_today: 36_000_000, total_driving_today: 11_640_000,
  total_otherwork_today: 5_640_000, total_availability_today: 0,
  remain_driving_week: 172_440_000, max_driving_week: 201_600_000,
  extended_shifts: 0, max_extended_shifts: 2, reduced_rests: 0, max_reduced_rests: 3, infringements: false,
  current_shift_start: '2026-11-03T03:31:00Z', latest_end_current_shift: '2026-11-03T18:31:00Z',
  earliest_start_next_shift: '2026-11-03T17:50:00Z', last_activity_from_drivercard: '2026-11-03T03:32:00Z'
};
const berlin = (iso: string | null) => iso ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : null;
const hm = (ms: number | null) => ms === null ? null : `${Math.floor(ms / 3_600_000)} h ${Math.floor(ms / MIN) % 60} min`;

describe('numbers from the Webfleet screen', () => {
  it('derives clock times and totals exactly as the Webfleet card shows them', () => {
    const times = parseDrivingTimesRow(drivingRow)!;
    expect(berlin(times.nextBreakAt)).toBe('11:06');
    expect(berlin(times.nextRestAt)).toBe('19:31');
    expect(berlin(times.shiftStartedAt)).toBe('04:31');
    expect(berlin(times.latestShiftEndAt)).toBe('19:31');
    expect(berlin(times.earliestNextShiftAt)).toBe('18:50');
    expect(berlin(times.lastCardActivityAt)).toBe('04:32');
    expect(hm(times.remainDrivingTodayMs)).toBe('6 h 46 min');
    expect(hm(times.totalDrivingTodayMs! + times.totalOtherWorkTodayMs! + times.totalAvailabilityTodayMs!)).toBe('4 h 48 min');
    expect(hm(times.totalOtherWorkTodayMs)).toBe('1 h 34 min');
    expect(hm(times.remainDrivingWeekMs)).toBe('47 h 54 min');
    expect(times).toMatchObject({ extendedShiftsUsed: 0, maxExtendedShifts: 2, reducedRestsUsed: 0, maxReducedRests: 3, nextBreakMinMs: 1_800_000, nextRestMinMs: 32_400_000 });
  });

  it('reads the vehicle tab values in the documented units', () => {
    expect(parseWebfleetObjectRow(objectRow)).toMatchObject({
      speedKmh: 84, courseDeg: 121, address: '06268 Obhausen, DE', fuelPercent: 15, odometerKm: 1566.9, engineHours: 33.4,
      objectName: 'MB', tripMode: 2, isTrailer: false, driver: { driverUid: 'drv-test-1', name: 'Max Mustermann', workState: 5 }
    });
    expect(parseDriverActivityRow({ driveruid: 'd', current_workstate: '5', current_workingtimeend: '2026-11-03T07:46:01Z' }))
      .toEqual({ driverUid: 'd', workState: 5, since: '2026-11-03T07:46:01.000Z' });
    expect(parseVehicleReportRow({ objectuid: 'o', licenseplatenumber: 'B CY 2803', identnumber: 'WDB0000000TEST001', fueltanksize: 880 }))
      .toEqual({ objectUid: 'o', plate: 'B CY 2803', vin: 'WDB0000000TEST001', tankLiters: 880 });
  });

  it('reads trips and events', () => {
    expect(parseTripRow({ tripid: '1001', objectuid: 'o', start_time: '2026-11-03T03:30:00Z', end_time: '2026-11-03T05:44:38Z', start_postext: 'BASE Northeim', end_postext: 'Lindenstraße, 37355 Niederorschel, DE', distance: 99040, tripmode: 2, drivername: 'Max Mustermann' }))
      .toEqual({ id: '1001', objectUid: 'o', objectNo: null, startAt: '2026-11-03T03:30:00.000Z', endAt: '2026-11-03T05:44:38.000Z', startAddress: 'BASE Northeim', endAddress: 'Lindenstraße, 37355 Niederorschel, DE', distanceKm: 99, businessTrip: true });
    expect(parseEventRow({ eventid: '2001', objectuid: 'o', eventtime: '2026-11-03T07:44:18Z', eventlevel_cur: 'W', msgtext: 'Geschwindigkeit', restime: '' }))
      .toMatchObject({ id: '2001', level: 'WARNING', text: 'Geschwindigkeit', resolved: false });
    // The live API sends ids as JSON numbers.
    expect(parseEventRow({ eventid: 2001, objectuid: 'o', eventtime: '2026-11-03T07:44:18Z', eventlevel: 'I' })).toMatchObject({ id: '2001', level: 'INFO' });
    expect(parseTripRow({ tripid: 1001, start_time: '2026-11-03T03:30:00Z' })).toMatchObject({ id: '1001' });
  });
});

describe('stored history', () => {
  it('stores truck facts but never the driver', async () => {
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'B CY 2803' } });
    const service = new WebfleetTelemetryService(pg());
    await service.applyPosition(parseWebfleetObjectRow(objectRow)!, new Date('2026-11-03T08:55:00Z'));
    const stored = await db.vehicleTelemetry.findFirstOrThrow({ where: { vehicleId: vehicle.id } });
    expect(stored.speedKmh).toBe(84);
    expect(stored.rawJson).not.toContain('Mustermann');
    expect(stored.rawJson).not.toContain('7243571758E');
    expect(await service.latest(vehicle.id, new Date('2026-11-03T08:55:00Z'))).toMatchObject({ fuelPercent: 15, objectName: 'MB', tripMode: 2 });
  });
});

describe('report schedule', () => {
  function syncWith(handler: (action: WebfleetReadAction) => unknown[]) {
    const store = new WebfleetLiveStore();
    const request = vi.fn(async (_config: unknown, action: WebfleetReadAction) => handler(action));
    return { store, request, sync: new WebfleetDetailsSync(store, config, request) };
  }

  it('waits for a successful snapshot and keeps 1-per-minute reports apart', async () => {
    const { store, request, sync } = syncWith(() => []);
    const start = new Date('2026-11-03T08:00:00Z');
    await sync.refreshIfDue(start);
    expect(request).not.toHaveBeenCalled();

    store.setObjects([], start);
    await sync.refreshIfDue(start);
    const first = request.mock.calls.map((call) => call[1]);
    expect(first).toEqual(expect.arrayContaining(['getRemainingDrivingTimesEU', 'showDriverReportExtern', 'getActiveAssetCouplings', 'showVehicleReportExtern', 'showOptiDriveIndicator', 'showMaintenanceSchedules', 'showEventReportExtern']));
    expect(first).not.toContain('showTripReportExtern');

    const soon = new Date(start.getTime() + 30_000);
    store.setObjects([], soon);
    await sync.refreshIfDue(soon);
    expect(request.mock.calls.slice(first.length)).toHaveLength(0);

    const later = new Date(start.getTime() + SLOW_REPORT_GAP_MS);
    store.setObjects([], later);
    await sync.refreshIfDue(later);
    expect(request.mock.calls.slice(first.length).map((call) => call[1])).toEqual(['showTripReportExtern']);
  });

  it('pauses a failing report without touching the others', async () => {
    const { store, sync } = syncWith((action) => {
      if (action === 'getRemainingDrivingTimesEU') throw new WebfleetError('PERMISSION', 55);
      return action === 'showVehicleReportExtern' ? [{ objectuid: 'o', fueltanksize: 880 }] : [];
    });
    const now = new Date('2026-11-03T08:00:00Z');
    store.setObjects([], now);
    await sync.refreshIfDue(now);
    expect(store.drivingFeed).toMatchObject({ error: 'PERMISSION', providerCode: 55, nextAt: now.getTime() + 30 * MIN });
    expect(store.vehicleInfo('o')).toMatchObject({ tankLiters: 880 });
  });
});

describe('vehicle card', () => {
  it('fills every tab from stored facts and the live store', async () => {
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: '2803-card' } });
    await db.vehicleIntegration.create({ data: { vehicleId: vehicle.id, provider: 'WEBFLEET', externalId: 'obj-card', externalNumber: 'B CY 2803' } });
    const now = new Date('2026-11-03T08:55:00Z');
    const store = new WebfleetLiveStore();
    const latest = async () => ({
      recordedAt: new Date('2026-11-03T08:54:17Z'), ageSeconds: 43, stale: false, usable: true, latitude: 51.41, longitude: 11.68,
      speedKmh: 84, ignitionOn: true, standstill: false, courseDeg: 121, address: '06268 Obhausen, DE', fuelPercent: 15, odometerKm: 1566.9,
      engineHours: 33.4, ignitionChangedAt: '2026-11-03T07:05:09.000Z', objectType: 'heavy_truck', objectName: 'MB', tripMode: 2
    });

    expect((await buildVehicleCard(pg(), store, latest, vehicle.id, now)).driver).toEqual({ status: 'WAITING' });

    store.setObjects([{ ...parseWebfleetObjectRow(objectRow)!, objectUid: 'obj-card' }], now);
    store.setVehicles([{ objectUid: 'obj-card', plate: 'B CY 2803', vin: 'VIN', tankLiters: 880 }], now);
    store.setDrivingTimes([parseDrivingTimesRow(drivingRow)!], [{ driverUid: 'drv-test-1', workState: 5, since: '2026-11-03T07:46:01.000Z' }], now);
    store.setOptiDrive([{ driverUid: 'drv-test-1', indicator: 0.798 }], now);
    store.setTrips([parseTripRow({ tripid: 't1', objectuid: 'obj-card', start_time: '2026-11-03T03:30:00Z', end_time: '2026-11-03T05:44:38Z', distance: 99040 })!], now);
    store.setEvents([parseEventRow({ eventid: 'e1', objectuid: 'obj-card', eventtime: '2026-11-03T07:44:18Z', eventlevel: 'A', msgtext: 'Alarm' })!], now);
    store.setCouplings([], now);
    const card = await buildVehicleCard(pg(), store, latest, vehicle.id, now);
    expect(card.webfleet).toMatchObject({ objectNo: 'B CY 2803', objectName: 'MB', tankLiters: 880 });
    expect(card.current).toMatchObject({ fuelPercent: 15, fuelLiters: 132, odometerKm: 1566.9, businessTrip: true });
    expect(card.coupling).toEqual({ status: 'OK', assetUid: null, assetNo: null, coupledAt: null });
    expect(card.driver).toMatchObject({ status: 'SIGNED_ON', name: 'Max Mustermann', workState: 5, activitySince: '2026-11-03T07:46:01.000Z', optiDrive: 7.98, drivingTimesStatus: 'OK' });
    expect(card.trips).toMatchObject({ status: 'OK', items: [{ id: 't1', distanceKm: 99 }] });
    expect(card.events).toMatchObject({ status: 'OK', unresolved: 1, items: [{ level: 'ALARM' }] });
    expect(card.maintenance).toEqual({ status: 'WAITING', items: [] });
  });

  it('shows an unbound truck without Webfleet tabs and rejects unknown trucks', async () => {
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'unbound-card' } });
    const card = await buildVehicleCard(pg(), new WebfleetLiveStore(), async () => null, vehicle.id);
    expect(card).toMatchObject({ webfleet: null, current: null, driver: null, events: null, trips: null });
    await expect(buildVehicleCard(pg(), new WebfleetLiveStore(), async () => null, 'missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('track', () => {
  it('caches per truck and limits requests per minute', async () => {
    const request = vi.fn(async () => [
      { pos_time: '2026-11-03T08:10:00Z', latitude: 51600000, longitude: 9950000 },
      { pos_time: '2026-11-03T08:00:00Z', latitude: 51500000, longitude: 9900000 }
    ]);
    const tracks = new WebfleetTrackService(config, request);
    const now = new Date('2026-11-03T09:00:00Z');
    expect((await tracks.track('o1', now)).points).toEqual([[9.9, 51.5], [9.95, 51.6]]);
    await tracks.track('o1', new Date(now.getTime() + 60_000));
    expect(request).toHaveBeenCalledTimes(1);
    for (let index = 2; index <= 5; index++) await tracks.track(`o${index}`, now);
    await expect(tracks.track('o6', now)).rejects.toMatchObject({ statusCode: 429 });
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
