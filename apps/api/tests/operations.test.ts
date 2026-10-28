import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';
import { TourService, makePersistedDrivePlan } from '../src/services/tours.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { OperationsService } from '../src/services/operations.js';
import { calculateDwellState, NotificationService } from '../src/services/notifications.js';
import { createInitialClockState, type ClockState } from '../src/services/vehicle-clock.js';
import { EtaService } from '../src/services/eta.js';
import { tourInclude } from '../src/services/tours.js';

let db: PrismaClient;
let directory: string;
const start = new Date('2026-10-11T08:00:00Z');
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-operations-test-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

async function fixture(label: string, options: { clock?: ClockState; appointmentAt?: string } = {}) {
  const clock = options.clock ?? createInitialClockState({ effectiveAt: start });
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: label, clockState: JSON.stringify(clock) } });
  const tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const service = new OperationsService(asAppDatabase(db), tours);
  const tour = await tours.createTour({ vehicleId: vehicle.id, orderNumber: label, stops: [
    { sequence: 1, type: 'LOAD', address: 'Berlin', city: 'Berlin', latitude: 52.52, longitude: 13.405 },
    { sequence: 2, type: 'UNLOAD', address: 'Hamburg', city: 'Hamburg', latitude: 53.55, longitude: 9.99, appointmentAt: options.appointmentAt }
  ] });
  await db.stop.update({ where: { id: tour.stops[0].id }, data: { completedAt: start, arrivedAt: start } });
  const leg = await db.leg.update({ where: { id: tour.legs[0].id }, data: {
    status: 'ACTIVE', startedAt: start, simulatedDurationSeconds: 7200,
    drivePlan: JSON.stringify(makePersistedDrivePlan(clock, 7200, start))
  } });
  return { vehicle, tours, service, tour, leg, stop: tour.stops[1], notices: new NotificationService(asAppDatabase(db), tours) };
}

it('keeps existing unknown machine clocks preliminary and refuses undated exception proposals', async () => {
  const f = await fixture('UNKNOWN');
  await db.vehicle.update({ where: { id: f.vehicle.id }, data: { clockState: null } });
  await db.leg.update({ where: { id: f.leg.id }, data: { drivePlan: null } });
  const result = await f.service.get(f.vehicle.id, start);
  expect(result.preliminary).toBe(true);
  expect(result.clock.kind).toBe('UNKNOWN');
  expect(result.clockProposals).toEqual([]);
  await expect(f.service.acceptException(f.vehicle.id, result.version, 'EXTENDED_DRIVING', start)).rejects.toThrow();
  const known = await fixture('UNDATED', { clock: createInitialClockState({ effectiveAt: start, drivingSeconds: 8 * 3600, dutySeconds: 9 * 3600 }) });
  expect((await known.service.get(known.vehicle.id, start)).clockProposals).toEqual([]);
});

it('persists and deduplicates predicted arrival without recording an actual arrival', async () => {
  const f = await fixture('ARRIVAL');
  await f.notices.refresh(at(121));
  await new NotificationService(asAppDatabase(db), new TourService(asAppDatabase(db), new MockRoutingProvider())).refresh(at(125));
  const rows = await db.notification.findMany({ where: { vehicleId: f.vehicle.id, type: 'PREDICTED_ARRIVAL' } });
  expect(rows).toHaveLength(1);
  expect(rows[0].message).toContain('ARRIVAL');
  expect(rows[0].message).toContain('Hamburg');
  expect((await db.stop.findUniqueOrThrow({ where: { id: f.stop.id } })).arrivedAt).toBeNull();
  await expect(f.tours.recordUnloaded(f.stop.id, at(125))).rejects.toThrow('подтвердить прибытие');
  await f.service.confirmArrival(f.stop.id, at(122), at(125));
  await f.service.confirmArrival(f.stop.id, at(122), at(125));
  expect(await db.operationEvent.count({ where: { stopId: f.stop.id, type: 'ARRIVAL_CONFIRMED' } })).toBe(1);
  expect((await db.notification.findUniqueOrThrow({ where: { id: rows[0].id } })).acknowledgedAt).not.toBeNull();
  expect((await f.service.get(f.vehicle.id, at(132))).dwellMinutes).toBe(10);
  await f.notices.refresh(at(250));
  await f.notices.refresh(at(260));
  expect(await db.notification.count({ where: { stopId: f.stop.id, type: 'LONG_DWELL' } })).toBe(1);
  await f.tours.recordUnloaded(f.stop.id, at(270));
  const completed = await db.stop.findUniqueOrThrow({ where: { id: f.stop.id } });
  expect((completed.completedAt!.getTime() - completed.arrivedAt!.getTime()) / 60000).toBe(148);
});

it('classifies confirmed dwell at the exact 60/61/120/121 minute boundaries', () => {
  const stop = {
    arrivedAt: start,
    completedAt: null,
    serviceMinMinutes: 60,
    serviceMaxMinutes: 120
  };
  expect(calculateDwellState(stop, at(60))).toEqual({ dwellMinutes: 60, dwellSeverity: 'NONE' });
  expect(calculateDwellState(stop, at(61))).toEqual({ dwellMinutes: 61, dwellSeverity: 'WARNING' });
  expect(calculateDwellState(stop, at(120))).toEqual({ dwellMinutes: 120, dwellSeverity: 'WARNING' });
  expect(calculateDwellState(stop, at(121))).toEqual({ dwellMinutes: 121, dwellSeverity: 'CRITICAL' });
  expect(calculateDwellState({ ...stop, completedAt: at(59) }, at(121))).toEqual({ dwellMinutes: null, dwellSeverity: 'NONE' });
});

it('creates one long-dwell notification after 60 minutes and upgrades it after 120 minutes', async () => {
  const f = await fixture('DWELL-LEVELS');
  await f.service.confirmArrival(f.stop.id, start, start);

  await f.notices.refresh(at(60));
  expect(await db.notification.count({ where: { stopId: f.stop.id, type: 'LONG_DWELL' } })).toBe(0);

  await f.notices.refresh(at(61));
  const warning = await db.notification.findUniqueOrThrow({ where: { dedupKey: `dwell:${f.stop.id}` } });
  expect(JSON.parse(warning.payloadJson)).toMatchObject({ dwellMinutes: 61, severity: 'WARNING' });
  await f.notices.acknowledge(warning.id, at(62));
  await f.notices.refresh(at(120));
  expect(await db.notification.count({ where: { stopId: f.stop.id, type: 'LONG_DWELL' } })).toBe(1);
  expect((await db.notification.findUniqueOrThrow({ where: { id: warning.id } })).acknowledgedAt).not.toBeNull();

  await f.notices.refresh(at(121));
  const critical = await db.notification.findUniqueOrThrow({ where: { id: warning.id } });
  expect(JSON.parse(critical.payloadJson)).toMatchObject({ dwellMinutes: 121, severity: 'CRITICAL' });
  expect(critical.acknowledgedAt).toBeNull();
  expect(await db.notification.count({ where: { stopId: f.stop.id, type: 'LONG_DWELL' } })).toBe(1);

  await f.notices.refresh(at(130));
  expect(await db.notification.count({ where: { stopId: f.stop.id, type: 'LONG_DWELL' } })).toBe(1);
});

it('freezes movement but consumes duty during manual stop, and resumes without losing progress', async () => {
  const f = await fixture('MANUAL');
  const before = await f.service.get(f.vehicle.id, at(30));
  const stopped = await f.service.manualStop(f.vehicle.id, before.version, at(30));
  const later = await new OperationsService(asAppDatabase(db), f.tours).get(f.vehicle.id, at(90));
  expect(later.position.progress).toBe(stopped.position.progress);
  expect(later.position.status).toBe('WAITING');
  expect(later.clock.currentCycle.drivingSeconds).toBe(1800);
  expect(later.clock.currentCycle.dutySeconds).toBe(5400);
  const resumed = await f.service.resume(f.vehicle.id, later.version, at(90));
  expect(resumed.position.progress).toBeCloseTo(0.25);
  const moved = await f.service.get(f.vehicle.id, at(120));
  expect(moved.position.progress).toBeCloseTo(0.5);
  expect(moved.clock.currentCycle.drivingSeconds).toBe(3600);
  expect(moved.clock.currentCycle.dutySeconds).toBe(7200);
  await expect(f.service.manualStop(f.vehicle.id, before.version, at(121))).rejects.toThrow();
});

it('blocks resume during breakdown and suppresses unknown or overdue repair ETA without changing drive hours', async () => {
  const f = await fixture('BREAKDOWN');
  await f.service.manualStop(f.vehicle.id, 0, at(30));
  const issue = await db.vehicleIssue.create({ data: { vehicleId: f.vehicle.id, kind: 'BREAKDOWN', description: 'Engine fault' } });
  const stopped = await f.tours.getCurrentPosition(f.vehicle.id, at(90));
  expect(stopped.progress).toBeCloseTo(0.25);
  expect(stopped.status).toBe('WAITING');
  expect(stopped.eta).toBeNull();
  const load = () => asAppDatabase(db).tour.findUniqueOrThrow({ where: { id: f.tour.id }, include: tourInclude });
  const unknown = new EtaService().calculateVehicleSchedule([await load()], at(90));
  expect(unknown[0].predictedEta).toBeNull();
  expect(unknown[0].latestDeparture).toBeNull();
  await expect(f.service.resume(f.vehicle.id, 1, at(90))).rejects.toThrow('завершение ремонта');
  expect(await db.operationEvent.count({ where: { vehicleId: f.vehicle.id, type: 'MOVEMENT_RESUMED' } })).toBe(0);
  await db.vehicleIssue.update({ where: { id: issue.id }, data: { expectedResolvedAt: at(120) } });
  const conditional = new EtaService().calculateVehicleSchedule([await load()], at(90));
  expect(conditional[0].predictedEta).toEqual(at(210));
  expect(conditional[0].preliminary).toBe(true);
  expect((await f.tours.getCurrentPosition(f.vehicle.id, at(90))).eta).toBe(at(210).toISOString());
  expect((await f.tours.getCurrentPosition(f.vehicle.id, at(125))).eta).toBeNull();
  const clock = (await f.service.get(f.vehicle.id, at(125))).clock;
  expect(clock.currentCycle.drivingSeconds).toBe(1800);
  expect(clock.currentCycle.dutySeconds).toBe(7500);
  await db.vehicleIssue.update({ where: { id: issue.id }, data: { resolvedAt: at(125) } });
  const resumed = await f.service.resume(f.vehicle.id, 1, at(125));
  expect(resumed.position.status).toBe('MOVING');
  expect(resumed.position.progress).toBeCloseTo(0.25);
});

it('reserves a useful extension once and restores its allowance when cancelled before use', async () => {
  const clock = createInitialClockState({ effectiveAt: start, drivingSeconds: 8 * 3600, dutySeconds: 9 * 3600 });
  const f = await fixture('EXCEPTION', { clock, appointmentAt: at(180).toISOString() });
  const initial = await f.service.get(f.vehicle.id, start);
  expect(initial.clockProposals.some(p => p.kind === 'EXTENDED_DRIVING')).toBe(true);
  const accepted = await f.service.acceptException(f.vehicle.id, initial.version, 'EXTENDED_DRIVING', start);
  const repeated = await f.service.acceptException(f.vehicle.id, accepted.version, 'EXTENDED_DRIVING', start);
  expect(repeated.clock.weeklyExtendedDrive.used).toBe(1);
  expect(await db.operationEvent.count({ where: { vehicleId: f.vehicle.id, type: 'EXCEPTION_RESERVED' } })).toBe(1);
  const cancelled = await f.service.cancelExceptions(f.vehicle.id, repeated.version, start);
  expect(cancelled.clock.weeklyExtendedDrive.used).toBe(0);
  expect(cancelled.clock.currentCycle.extendedDriveReservationId).toBeNull();
});

it('saves clock correction with real millisecond timestamps and records its reason', async () => {
  const f = await fixture('CLOCK-SET');
  const now = new Date('2026-10-11T08:00:00.321Z');
  const result = await f.service.setClock(f.vehicle.id, {
    version: 0, cycleStartedAt: '2026-10-11T06:00:00Z', dailyDrivingMinutes: 60,
    drivingSinceBreakMinutes: 60, extendedDrivingUsed: 0, reducedRestUsed: 0,
    reason: 'Initial dispatch data'
  }, now);
  expect(result.clock.currentCycle.drivingSeconds).toBe(3600);
  expect(await db.operationEvent.count({ where: { vehicleId: f.vehicle.id, type: 'CLOCK_CORRECTION', reason: 'Initial dispatch data' } })).toBe(1);
});

it('accepts explicitly accounted current-cycle exceptions and rejects unaccounted allowances', async () => {
  const f = await fixture('INITIAL-EXTENSIONS');
  const input = {
    version: 0, cycleStartedAt: '2026-10-10T18:00:00Z', dailyDrivingMinutes: 570,
    drivingSinceBreakMinutes: 120, extendedDrivingUsed: 1, reducedRestUsed: 1,
    currentExtendedDriving: true, currentReducedRest: true, reason: 'Actual current cycle exceptions'
  };
  const result = await f.service.setClock(f.vehicle.id, input, start);
  expect(result.clock.currentCycle.drivingSeconds).toBe(570 * 60);
  expect(result.clock.currentCycle.dutySeconds).toBe(14 * 3600);
  expect(result.clock.currentCycle.extendedDriveReservationId).toBeTruthy();
  expect(result.clock.currentCycle.reducedRestReservationId).toBeTruthy();
  expect(result.clock.weeklyExtendedDrive.used).toBe(1);
  expect(result.clock.reducedRestsSinceWeeklyRest).toBe(1);
  await expect(f.service.setClock(f.vehicle.id, { ...input, version: result.version, extendedDrivingUsed: 0 }, start)).rejects.toThrow();
});
