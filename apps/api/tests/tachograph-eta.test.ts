import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { EtaService } from '../src/services/eta.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { driverBudgetAfterRest, forecastEta, ClockEngine, WebfleetEngine, type DriverBudget } from '../src/services/termin-planner.js';
import { TourService } from '../src/services/tours.js';
import { createUnknownClockState } from '../src/services/vehicle-clock.js';
import { readDriverBudget, WebfleetLiveStore, type WebfleetDrivingTimes } from '../src/services/webfleet-live.js';
import type { WebfleetPosition } from '../src/services/webfleet.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

const H = 3600;
/**
 * LKW B-CY2853 on 09.11.2026 at 14:39 Berlin (13:39Z), from the dispatcher's screen: 4 h 22 min of driving left,
 * break due in 4 h 16 min, shift and daily rest no later than 18:56 Berlin (17:56Z), 423 km = 6 h 12 min to Grünheide.
 */
const now = new Date('2026-11-09T13:39:00Z');
const DRIVE = 6 * H + 12 * 60;
const budget = (overrides: Partial<DriverBudget> = {}): DriverBudget => ({
  referenceTime: '2026-11-09T13:33:00Z', workState: 5, activitySince: '2026-11-09T13:27:00Z',
  continuousDriveLeftSeconds: 4 * H + 16 * 60, breakSeconds: 45 * 60, dailyDriveLeftSeconds: 4 * H + 22 * 60, drivenTodaySeconds: 5 * H + 27 * 60, maxDailyDriveSeconds: 10 * H,
  shiftEndAt: '2026-11-09T17:56:00Z', restLatestAt: '2026-11-09T17:56:00Z', restSeconds: 11 * H,
  weeklyDriveLeftSeconds: 30 * H, extendedShiftsLeft: 1, reducedRestsLeft: 2, earliestNextShiftAt: null, breakRemainingSeconds: 0,
  ...overrides
});
const iso = (value: Date | string) => new Date(value).toISOString();

describe('ETA on the driver\'s hours (LKW B-CY2853)', () => {
  it('stops at the end of the shift, rests 11 h and arrives the next morning, not at 20:51', () => {
    const result = forecastEta(new WebfleetEngine(budget()), DRIVE, now, null);
    expect(iso(result.endAt)).toBe('2026-11-10T06:51:00.000Z');
    expect(result.plan).toMatchObject({ hours: 'TACHOGRAPH', preliminary: false, driveSeconds: DRIVE, breakSeconds: 0, startsAt: null,
      rest: { startAt: '2026-11-09T17:55:00.000Z', endAt: '2026-11-10T04:55:00.000Z', seconds: 11 * H, reduced: false } });
  });

  it('shortens the rest to 9 h only when a Termin would otherwise be missed and a reduced rest is still allowed', () => {
    const early = forecastEta(new WebfleetEngine(budget()), DRIVE, now, new Date('2026-11-10T05:00:00Z'));
    expect(iso(early.endAt)).toBe('2026-11-10T04:51:00.000Z');
    expect(early.plan.rest).toMatchObject({ seconds: 9 * H, reduced: true, endAt: '2026-11-10T02:55:00.000Z' });

    const comfortable = forecastEta(new WebfleetEngine(budget()), DRIVE, now, new Date('2026-11-10T08:00:00Z'));
    expect(comfortable.plan.rest).toMatchObject({ seconds: 11 * H, reduced: false });

    const exhausted = forecastEta(new WebfleetEngine(budget({ reducedRestsLeft: 0 })), DRIVE, now, new Date('2026-11-10T05:00:00Z'));
    expect(exhausted.plan.rest).toMatchObject({ seconds: 11 * H, reduced: false });
    expect(iso(exhausted.endAt)).toBe('2026-11-10T06:51:00.000Z');

    // Still late with 9 h: the owner wants the smallest real delay shown, with the reduced rest named.
    const late = forecastEta(new WebfleetEngine(budget()), DRIVE, now, new Date('2026-11-10T04:00:00Z'));
    expect(iso(late.endAt)).toBe('2026-11-10T04:51:00.000Z');
    expect(late.plan.rest).toMatchObject({ reduced: true });
    expect(late.endAt.getTime()).toBeGreaterThan(Date.parse('2026-11-10T04:00:00Z'));
  });

  it('a short drive inside the day needs no rest, and a 45 min break appears when 4 h 30 run out', () => {
    const short = forecastEta(new WebfleetEngine(budget()), 2 * H, now, new Date('2026-11-09T15:00:00Z'));
    expect(iso(short.endAt)).toBe('2026-11-09T15:39:00.000Z');
    expect(short.plan).toMatchObject({ rest: null, breakSeconds: 0 });
    const rested = forecastEta(new WebfleetEngine(budget({ continuousDriveLeftSeconds: 1 * H, dailyDriveLeftSeconds: 8 * H, shiftEndAt: '2026-11-09T23:00:00Z' })), 2 * H, now, null);
    expect(short.plan.hours).toBe('TACHOGRAPH');
    expect(rested.plan).toMatchObject({ rest: null, breakSeconds: 45 * 60 });
    expect(iso(rested.endAt)).toBe('2026-11-09T16:24:00.000Z');
  });

  it('a driver whose card is out leaves at the start of the next shift with a fresh day', () => {
    const times = { referenceTime: '2026-11-09T12:00:00Z', remainDrivingWeekMs: 30 * H * 1000, maxExtendedShifts: 2, extendedShiftsUsed: 1, maxReducedRests: 3, reducedRestsUsed: 3 } as WebfleetDrivingTimes;
    const startsAt = new Date('2026-11-10T04:00:00Z');
    const fresh = driverBudgetAfterRest(times, startsAt);
    expect(fresh).toMatchObject({ dailyDriveLeftSeconds: 9 * H, continuousDriveLeftSeconds: 4.5 * H, shiftEndAt: '2026-11-10T17:00:00.000Z', reducedRestsLeft: 0, extendedShiftsLeft: 1, earliestNextShiftAt: startsAt.toISOString() });
    const result = forecastEta(new WebfleetEngine(fresh), 3 * H, now, null, startsAt);
    expect(iso(result.endAt)).toBe('2026-11-10T07:00:00.000Z');
    expect(result.plan).toMatchObject({ startsAt: startsAt.toISOString(), rest: null });
  });

  it('the calculated clock never shortens a rest by itself and stays preliminary', () => {
    const engine = new ClockEngine(createUnknownClockState(now));
    const result = forecastEta(engine, 10 * H, now, new Date('2026-11-09T20:00:00Z'));
    expect(result.plan.hours).toBe('CLOCK');
    expect(result.plan.preliminary).toBe(true);
    expect(result.plan.rest).toMatchObject({ seconds: 11 * H, reduced: false });
  });
});

describe('positions, schedules and the tachograph', () => {
  let directory: string;
  let db: PrismaClient;
  const pg = () => db as unknown as PostgresPrismaClient;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-tachograph-eta-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
  }, 20_000);
  afterAll(async () => {
    await db?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const line = [{ latitude: 52.26, longitude: 8.62 }, { latitude: 52.45, longitude: 11.0 }, { latitude: 52.42, longitude: 13.7 }];
  async function tourFor(number: string, appointmentAt: Date | null) {
    const service = new TourService(asAppDatabase(db), new MockRoutingProvider());
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: number } });
    await service.createTour({ vehicleId: vehicle.id, orderNumber: `SHP-${number}`, stops: [
      { sequence: 1, type: 'LOAD', address: 'Espelkamp', latitude: 52.26, longitude: 8.62 },
      { sequence: 2, type: 'UNLOAD', address: 'Grünheide (Mark)', latitude: 52.42, longitude: 13.7, appointmentAt: appointmentAt?.toISOString() ?? undefined }
    ] });
    const leg = await db.leg.findFirstOrThrow({ where: { tour: { vehicleId: vehicle.id } } });
    await db.leg.update({ where: { id: leg.id }, data: { status: 'ACTIVE', startedAt: new Date(now.getTime() - 60_000), routeGeometry: JSON.stringify(line), distanceMeters: 423_000, simulatedDurationSeconds: DRIVE } });
    return { service, vehicle };
  }

  it('the position ETA of the active leg follows the tachograph, with GPS and with the timer', async () => {
    const { service, vehicle } = await tourFor('B-CY2853', null);
    const gps = await service.getCurrentPosition(vehicle.id, now, { latitude: 52.26, longitude: 8.62, fresh: true }, { budget: budget(), startsAt: null });
    expect(gps.etaSource).toBe('GPS');
    expect(Date.parse(gps.eta!)).toBeGreaterThan(Date.parse('2026-11-10T06:45:00Z'));
    expect(Date.parse(gps.eta!)).toBeLessThan(Date.parse('2026-11-10T07:00:00Z'));
    expect(gps.etaPlan).toMatchObject({ hours: 'TACHOGRAPH', rest: { seconds: 11 * H, reduced: false } });

    const timer = await service.getCurrentPosition(vehicle.id, now, null, { budget: budget(), startsAt: null });
    expect(timer.etaSource).toBe('CALCULATED');
    expect(Date.parse(timer.eta!)).toBeGreaterThan(Date.parse('2026-11-10T06:45:00Z'));
    expect(timer.etaPlan?.rest).toMatchObject({ seconds: 11 * H });

    // Without the tachograph nothing changes: the ETA is the drive from the clock, as before.
    const plain = await service.getCurrentPosition(vehicle.id, now, { latitude: 52.26, longitude: 8.62, fresh: true });
    expect(Date.parse(plain.eta!)).toBeLessThan(Date.parse('2026-11-09T21:00:00Z'));
    expect(plain.etaPlan).toBeNull();
  });

  it('an early Termin makes the position ETA take the 9 h rest and report the delay honestly', async () => {
    const { service, vehicle } = await tourFor('B-CY2853-T', new Date('2026-11-10T04:00:00Z'));
    const position = await service.getCurrentPosition(vehicle.id, now, { latitude: 52.26, longitude: 8.62, fresh: true }, { budget: budget(), startsAt: null });
    expect(position.etaPlan?.rest).toMatchObject({ seconds: 9 * H, reduced: true });
    expect(position.delayMinutes).toBeGreaterThan(40);
    expect(position.delayMinutes).toBeLessThan(60);
  });

  it('the schedule of the next stops runs on the tachograph too and is no longer preliminary', () => {
    const schedule = new EtaService().calculateVehicleSchedule([{
      id: 'tour', status: 'ACTIVE', queueIndex: 0, createdAt: now, plannedStartAt: null, vehicleId: 'v', approachDurationSeconds: null,
      vehicle: { clockState: null },
      stops: [
        { id: 'a', sequence: 1, type: 'LOAD', address: 'Espelkamp', city: null, appointmentAt: null, appointmentWindowStartAt: null, appointmentWindowEndAt: null, arrivedAt: new Date('2026-11-09T12:00:00Z'), completedAt: new Date('2026-11-09T13:38:00Z'), serviceMinMinutes: 60, serviceMaxMinutes: 120 },
        { id: 'b', sequence: 2, type: 'UNLOAD', address: 'Grünheide', city: null, appointmentAt: null, appointmentWindowStartAt: null, appointmentWindowEndAt: null, arrivedAt: null, completedAt: null, serviceMinMinutes: 60, serviceMaxMinutes: 120 },
        { id: 'c', sequence: 3, type: 'LOAD', address: 'Berlin', city: null, appointmentAt: null, appointmentWindowStartAt: null, appointmentWindowEndAt: null, arrivedAt: null, completedAt: null, serviceMinMinutes: 60, serviceMaxMinutes: 120 }
      ],
      legs: [
        { toStopId: 'b', fromStopId: 'a', status: 'ACTIVE', startedAt: new Date(now.getTime() - 60_000), simulatedDurationSeconds: DRIVE, drivePlan: null },
        { toStopId: 'c', fromStopId: 'b', status: 'WAITING', startedAt: null, simulatedDurationSeconds: 3600, drivePlan: null }
      ]
    }] as never, now, { budget: budget(), startsAt: null });
    const [b, c] = schedule;
    expect(b.stopId).toBe('b');
    expect(b.predictedEta!.getTime()).toBeGreaterThan(Date.parse('2026-11-10T06:45:00Z'));
    expect(b.predictedEta!.getTime()).toBeLessThan(Date.parse('2026-11-10T07:00:00Z'));
    expect(b.preliminary).toBe(false);
    // Berlin is an hour after the stay of 60–120 min in Grünheide, still inside the new day.
    expect(c.earliestArrival!.getTime()).toBeGreaterThan(Date.parse('2026-11-10T08:45:00Z'));
    expect(c.earliestArrival!.getTime()).toBeLessThan(Date.parse('2026-11-10T09:00:00Z'));
    expect(c.latestArrival!.getTime() - c.earliestArrival!.getTime()).toBe(60 * 60_000);
  });

  it('reads the budget of the signed-on driver, the next shift of a driver whose card is out, and nothing when the figures are old', async () => {
    const store = new WebfleetLiveStore();
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'B-CY2853-W' } });
    await db.vehicleIntegration.create({ data: { vehicleId: vehicle.id, provider: 'WEBFLEET', externalId: 'obj-2853', externalNumber: 'B CY 2853' } });
    const times: WebfleetDrivingTimes = {
      driverUid: 'drv-2853', name: null, referenceTime: '2026-11-09T13:33:00Z',
      remainDrivingTodayMs: (4 * H + 22 * 60) * 1000, totalDrivingTodayMs: (5 * H + 27 * 60) * 1000, totalOtherWorkTodayMs: 32 * 60_000, totalAvailabilityTodayMs: 0, maxDrivingTodayMs: 10 * H * 1000,
      remainDrivingWeekMs: 30 * H * 1000, maxDrivingWeekMs: 56 * H * 1000, shiftStartedAt: '2026-11-09T02:56:00Z', latestShiftEndAt: '2026-11-09T17:56:00Z',
      nextBreakAt: '2026-11-09T17:49:00Z', nextBreakMinMs: 30 * 60_000, nextRestAt: '2026-11-09T17:56:00Z', nextRestMinMs: 9 * H * 1000, earliestNextShiftAt: '2026-11-09T22:34:00Z',
      extendedShiftsUsed: 1, maxExtendedShifts: 2, reducedRestsUsed: 1, maxReducedRests: 3, restBalances: [], infringements: false, lastCardActivityAt: null
    };
    const object = (driver: { driverUid: string; workState: number } | null) => ({ objectUid: 'obj-2853', objectNo: 'B CY 2853', licensePlate: 'B CY 2853', isTrailer: false, driver }) as unknown as WebfleetPosition;

    store.setObjects([object({ driverUid: 'drv-2853', workState: 5 })], now);
    store.setDrivingTimes([times], [{ driverUid: 'drv-2853', workState: 5, since: '2026-11-09T13:27:00Z' }], now);
    const signedOn = await readDriverBudget(pg(), store, vehicle.id, now);
    expect(signedOn?.startsAt).toBeNull();
    // Six minutes at the wheel since the report are already subtracted.
    expect(signedOn?.budget).toMatchObject({ dailyDriveLeftSeconds: 4 * H + 16 * 60, shiftEndAt: '2026-11-09T17:56:00Z', reducedRestsLeft: 2 });

    // 19:00Z: the card is out, the truck stands; the last driver's next shift may begin at 22:34Z.
    const evening = new Date('2026-11-09T19:00:00Z');
    store.setObjects([object(null)], evening);
    const cardOut = await readDriverBudget(pg(), store, vehicle.id, evening);
    expect(cardOut?.startsAt?.toISOString()).toBe('2026-11-09T22:34:00.000Z');
    expect(cardOut?.budget).toMatchObject({ dailyDriveLeftSeconds: 9 * H, shiftEndAt: '2026-11-10T11:34:00.000Z' });

    // Signed on again, but the figures are older than an hour: no budget, the ETA falls back to the clock.
    const late = new Date('2026-11-09T15:00:00Z');
    store.setObjects([object({ driverUid: 'drv-2853', workState: 5 })], late);
    expect(await readDriverBudget(pg(), store, vehicle.id, late)).toBeNull();

    const unbound = await db.vehicle.create({ data: { vehicleNumber: 'no-webfleet' } });
    expect(await readDriverBudget(pg(), store, unbound.id, now)).toBeNull();
  });
});
