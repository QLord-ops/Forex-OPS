import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { EtaService } from '../src/services/eta.js';
import { RouteScenarioService } from '../src/services/route-scenario.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { ClockEngine, forecastRoute, WebfleetEngine, type DriverBudget } from '../src/services/termin-planner.js';
import { gpsClock, snapshotVehicleClock, TourService } from '../src/services/tours.js';
import { createInitialClockState, createUnknownClockState, VEHICLE_CLOCK_LIMITS } from '../src/services/vehicle-clock.js';
import { WebfleetTelemetryService } from '../src/services/webfleet.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

/**
 * Owner, 15.11.2026: every ETA must hold the stops on the way — on a long drive the 45-minute break after 4 h 30. One trip
 * of 7 hours of driving goes through every place that predicts an arrival; each must be at least 45 minutes later than the
 * pure drive. A new path that forgets the break fails here.
 */
const H = 3600;
const BREAK = 45 * 60;
const DRIVE = 7 * H;
const now = new Date('2026-11-16T05:00:00Z');
const pure = new Date(now.getTime() + DRIVE * 1000);
const atLeastBreakLater = (at: Date | string | null | undefined) => {
  expect(at).toBeTruthy();
  expect(new Date(at!).getTime() - pure.getTime()).toBeGreaterThanOrEqual(BREAK * 1000);
};
const freshBudget = (): DriverBudget => ({
  referenceTime: now.toISOString(), workState: 3, activitySince: now.toISOString(),
  continuousDriveLeftSeconds: 4.5 * H, breakSeconds: BREAK, dailyDriveLeftSeconds: 9 * H, drivenTodaySeconds: 0, maxDailyDriveSeconds: 9 * H,
  shiftEndAt: new Date(now.getTime() + 13 * H * 1000).toISOString(), restLatestAt: null, restSeconds: 11 * H,
  weeklyDriveLeftSeconds: 50 * H, extendedShiftsLeft: 2, reducedRestsLeft: 3, earliestNextShiftAt: null, breakRemainingSeconds: 0
});

let directory: string;
let db: PrismaClient;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-eta-breaks-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

const line = [{ latitude: 51.53, longitude: 9.93 }, { latitude: 51.8, longitude: 11.5 }, { latitude: 52.42, longitude: 13.7 }];
/** A truck that has just started a 7-hour leg from Göttingen to Grünheide, with no tachograph data. */
async function trip(number: string, drivePlan?: string | null) {
  const service = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: number } });
  const tour = await service.createTour({ vehicleId: vehicle.id, orderNumber: `ETA-${number}`, stops: [
    { sequence: 1, type: 'LOAD', address: 'Göttingen', latitude: 51.53, longitude: 9.93 },
    { sequence: 2, type: 'UNLOAD', address: 'Grünheide (Mark)', latitude: 52.42, longitude: 13.7 }
  ] });
  const leg = await db.leg.findFirstOrThrow({ where: { tourId: tour.id } });
  await db.leg.update({ where: { id: leg.id }, data: { status: 'ACTIVE', startedAt: now, routeGeometry: JSON.stringify(line), distanceMeters: 560_000,
    simulatedDurationSeconds: DRIVE, ...(drivePlan !== undefined ? { drivePlan } : {}) } });
  await db.stop.update({ where: { id: tour.stops[0].id }, data: { arrivedAt: new Date(now.getTime() - 2 * H * 1000), completedAt: now } });
  await db.tour.update({ where: { id: tour.id }, data: { status: 'ACTIVE' } });
  return { service, vehicle, tourId: tour.id, unloadId: tour.stops[1].id };
}

describe('every ETA of a 7-hour drive holds the 45-minute break', () => {
  it('the dashboard ETA from fresh GPS, on the calculated clock and on the tachograph, says so in its plan', async () => {
    const { service, vehicle } = await trip('E1');
    const atStart = { latitude: 51.53, longitude: 9.93, fresh: true };
    const plain = await service.getCurrentPosition(vehicle.id, now, atStart);
    atLeastBreakLater(plain.eta);
    expect(plain.etaPlan).toMatchObject({ hours: 'CLOCK', breakSeconds: BREAK });
    const tacho = await service.getCurrentPosition(vehicle.id, now, atStart, { budget: freshBudget(), startsAt: null });
    atLeastBreakLater(tacho.eta);
    expect(tacho.etaPlan).toMatchObject({ hours: 'TACHOGRAPH', breakSeconds: BREAK });
  });

  it('the dashboard ETA by the drive timer, also for an older leg without a planned drive', async () => {
    const { service, vehicle } = await trip('E2');
    atLeastBreakLater((await service.getCurrentPosition(vehicle.id, now, null)).eta);
    const legacy = await trip('E3', JSON.stringify({ version: 0, totalDriveSeconds: DRIVE, totalElapsedSeconds: DRIVE, segments: [{ kind: 'DRIVE', startOffsetSeconds: 0, durationSeconds: DRIVE }] }));
    const leg = await db.leg.findFirstOrThrow({ where: { tourId: legacy.tourId } });
    atLeastBreakLater(snapshotVehicleClock({ clockState: null }, leg, now).eta);
  });

  it('the schedule of the next stops (alerts, timeline, Termin check, assistant), on the clock and on the tachograph', async () => {
    const { vehicle } = await trip('E4');
    const tours = (await db.tour.findMany({ where: { vehicleId: vehicle.id }, include: { stops: { orderBy: { sequence: 'asc' } }, legs: true } }))
      .map((tour) => ({ ...tour, vehicle: { clockState: vehicle.clockState, manualStoppedAt: null, issues: [] } }));
    const eta = new EtaService();
    const last = (items: ReturnType<EtaService['calculateVehicleSchedule']>) => items.at(-1)?.predictedEta;
    atLeastBreakLater(last(eta.calculateVehicleSchedule(tours as never, now)));
    atLeastBreakLater(last(eta.calculateVehicleSchedule(tours as never, now, { budget: freshBudget(), startsAt: null })));
  });

  it('the preview of a new tour counts the stay at every stop on the way and the break', () => {
    // 3 h 30 to the loading, an hour there, 3 h 30 to the unloading: the hour of loading is the break.
    const clock = forecastRoute(new ClockEngine(createInitialClockState({ effectiveAt: now })), [3.5 * H, 3.5 * H], [H], now);
    expect(clock.endAt.toISOString()).toBe(new Date(now.getTime() + (DRIVE + H) * 1000).toISOString());
    expect(clock.plan.breakSeconds).toBe(0);
    // Without a long stay the 45 minutes come on the road.
    const straight = forecastRoute(new ClockEngine(createInitialClockState({ effectiveAt: now })), [3.5 * H, 3.5 * H], [15 * 60], now);
    expect(straight.plan.breakSeconds).toBe(BREAK);
    expect(straight.endAt.getTime() - now.getTime()).toBe((DRIVE + 15 * 60 + BREAK) * 1000);
    const tacho = forecastRoute(new WebfleetEngine(freshBudget()), [3.5 * H, 3.5 * H], [15 * 60], now);
    expect(tacho.plan).toMatchObject({ hours: 'TACHOGRAPH', breakSeconds: BREAK });
  });

  it('the free route A → B without a truck plans like a driver starting a fresh day', async () => {
    const coords = { latitude: 52, longitude: 13 };
    const route = vi.fn().mockResolvedValue({ geometry: [coords, coords], distanceMeters: 560_000, durationSeconds: DRIVE, provider: 'test' });
    const routing = { calculateRoute: route, calculateMultiStopRoute: route, geocode: vi.fn().mockResolvedValue({ ...coords, label: 'A', provider: 'test' }) };
    const scenario = new RouteScenarioService({} as PostgresPrismaClient, routing as never, vi.fn(), vi.fn());
    const result = await scenario.calculate({ originAddress: 'Göttingen', stops: [{ address: 'Grünheide' }] }, now);
    atLeastBreakLater(result.stops[0].earliestArrival);
  });
});

describe('a driver without tachograph data who has already been driving', () => {
  it('reads the driving since the last stop of 45 minutes from the GPS history', async () => {
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'E5' } });
    const telemetry = new WebfleetTelemetryService(db as unknown as PostgresPrismaClient);
    const row = (minutesBefore: number, standstill: boolean) => db.vehicleTelemetry.create({ data: { vehicleId: vehicle.id, provider: 'WEBFLEET', externalId: `wf-E5-${minutesBefore}`,
      latitude: 51.5, longitude: 9.9, speedKmh: standstill ? 0 : 80, recordedAt: new Date(now.getTime() - minutesBefore * 60_000), receivedAt: now,
      rawJson: JSON.stringify({ standstill }) } });
    // Stood an hour (night parking), then drove the last 4 hours with a 20-minute stop in between.
    for (let minute = 300; minute >= 241; minute -= 1) await row(minute, true);
    for (let minute = 240; minute >= 1; minute -= 1) await row(minute, minute >= 100 && minute < 120);
    const driven = await telemetry.drivingSinceBreak(vehicle.id, now);
    expect(driven).toBeGreaterThan(3.5 * H);
    expect(driven).toBeLessThan(4 * H);
  });

  it('then needs the break soon, not after another 4 h 30', () => {
    const fresh = gpsClock(createUnknownClockState(now), now, null);
    const tired = gpsClock(createUnknownClockState(now), now, 4 * H);
    expect(tired.currentCycle.continuousDrivingSeconds).toBe(4 * H);
    const firstBreak = (state: typeof fresh) => new ClockEngine(state).drive(DRIVE, now).pieces.find((piece) => piece.type === 'BREAK')!.startAt.getTime() - now.getTime();
    expect(firstBreak(fresh)).toBe(VEHICLE_CLOCK_LIMITS.breakAfterDrivingSeconds * 1000);
    expect(firstBreak(tired)).toBe(0.5 * H * 1000);
    // A known clock is never overridden by the GPS guess.
    const known = createInitialClockState({ effectiveAt: now, drivingSeconds: H, continuousDrivingSeconds: H });
    expect(gpsClock(known, now, 4 * H).currentCycle.continuousDrivingSeconds).toBe(H);
  });
});
