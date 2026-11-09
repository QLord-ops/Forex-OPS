import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurrentPosition } from '../src/domain.js';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { AlertService } from '../src/services/alerts.js';
import { matchAppointment } from '../src/services/appointment-match.js';
import { AppointmentService } from '../src/services/appointments.js';
import { DailyStatusService } from '../src/services/daily-status.js';
import { EtaService } from '../src/services/eta.js';
import { OperationsService } from '../src/services/operations.js';
import type { AppointmentDocument } from '../src/services/pdf-order-import.js';
import { ReplanningService } from '../src/services/replanning.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { samePlace, shareTerminAtSamePlace, withTerminGroups } from '../src/services/termin-groups.js';
import type { DriverBudget } from '../src/services/termin-planner.js';
import { TerminService } from '../src/services/termin-service.js';
import { TourService, enrichTour, makePersistedDrivePlan, tourInclude } from '../src/services/tours.js';
import { createInitialClockState } from '../src/services/vehicle-clock.js';
import type { DriverHours } from '../src/services/webfleet-live.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;
// 05:00 in Berlin: the truck leaves Zwickau, the plant's Termin is 08:00. The day is in the past: BELADEN/ENTLADEN cannot be recorded ahead of the clock.
const start = new Date('2026-11-03T04:00:00Z');
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();
const TERMIN = iso(180);
const H = 3600;

const zwickau = { type: 'LOAD' as const, company: 'Lieferant Zwickau', address: 'Reichenbacher Straße 80, 08056 Zwickau', city: 'Zwickau', latitude: 50.72, longitude: 12.49 };
const plant = { type: 'UNLOAD' as const, company: 'VW Salzgitter', address: 'Industriestraße Nord 1, 38239 Salzgitter', city: 'Salzgitter', latitude: 52.19, longitude: 10.4 };
const leergut = { type: 'LOAD' as const, company: 'Volkswagen AG Werk Salzgitter', address: 'Industriestraße Nord 1, 38239 Salzgitter', city: 'Salzgitter',
  latitude: 52.1902, longitude: 10.4002, instructions: 'Leergut' };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-shared-termin-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

const pg = () => db as unknown as PostgresPrismaClient;
let counter = 0;

/** [LOAD Zwickau, UNLOAD VW Salzgitter, LOAD Leergut at the same plant]; the truck is on the road to the plant. */
async function fixture(options: { termin?: [string | null, string | null]; line?: string } = {}) {
  counter += 1;
  const label = `ST${counter}`;
  const clock = createInitialClockState({ effectiveAt: start });
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: label, licensePlate: `GÖ-ST ${100 + counter}`, line: options.line ?? null, clockState: JSON.stringify(clock) } });
  const routing = new MockRoutingProvider();
  const route = vi.spyOn(routing, 'calculateRoute');
  const tours = new TourService(asAppDatabase(db), routing);
  const [leadTermin, followerTermin] = options.termin ?? [TERMIN, null];
  const tour = await tours.createTour({ vehicleId: vehicle.id, orderNumber: label, stops: [
    { sequence: 1, ...zwickau },
    { sequence: 2, ...plant, appointmentAt: leadTermin },
    { sequence: 3, ...leergut, appointmentAt: followerTermin }
  ] });
  const routedTo = route.mock.calls.map(([, destination]) => destination);
  route.mockClear();
  await db.stop.update({ where: { id: tour.stops[0].id }, data: { completedAt: start, arrivedAt: start } });
  await db.leg.update({ where: { id: tour.legs[0].id }, data: {
    status: 'ACTIVE', startedAt: start, simulatedDurationSeconds: 2 * H, drivePlan: JSON.stringify(makePersistedDrivePlan(clock, 2 * H, start))
  } });
  const [, lead, follower] = tour.stops;
  return { vehicle, tour, lead, follower, routing, route, routedTo, tours, operations: new OperationsService(asAppDatabase(db), tours),
    appointments: new AppointmentService(pg()) };
}
const stored = (id: string) => db.stop.findUniqueOrThrow({ where: { id } });
const schedule = async (tourId: string, now: Date, driver: { budget: DriverBudget; startsAt: Date | null } | null = null) => new EtaService()
  .calculateVehicleSchedule([await asAppDatabase(db).tour.findUniqueOrThrow({ where: { id: tourId }, include: tourInclude })], now, driver);

describe('one place', () => {
  const ramp = { company: 'VW Salzgitter', address: 'Industriestraße Nord 1, 38239 Salzgitter', latitude: 52.19, longitude: 10.4 };
  it('is the same street and postcode within 300 m, whatever the gate is called', () => {
    expect(samePlace(ramp, { company: 'Leergutplatz Tor 3', address: 'Industriestr. Nord 1, 38239 Salzgitter', latitude: 52.191, longitude: 10.401 })).toBe(true);
  });
  it('is the same company under its abbreviation and its full name', () => {
    const yard = { company: 'Volkswagen AG Werk Salzgitter', address: 'Tor 3, 38239 Salzgitter', latitude: 52.1905, longitude: 10.4005 };
    expect(samePlace(ramp, yard)).toBe(true);
    // A town-centre coordinate says nothing about the plant: two names of one brand there are not one place.
    expect(samePlace({ ...ramp, geocodePrecision: 'CITY' }, { ...yard, geocodePrecision: 'CITY' })).toBe(false);
    expect(samePlace({ ...ramp, geocodePrecision: 'CITY' }, { ...ramp, company: 'VW Salzgitter GmbH', address: 'Salzgitter', geocodePrecision: 'CITY' })).toBe(true);
  });
  it('is never decided by distance alone, and ends beyond 300 m', () => {
    expect(samePlace(ramp, { company: 'MAN Truck & Bus', address: 'Heinrich-Büssing-Straße 1, 38239 Salzgitter', latitude: 52.19, longitude: 10.4 })).toBe(false);
    expect(samePlace(ramp, { ...ramp, latitude: 52.194 })).toBe(false);
    expect(samePlace(ramp, { ...ramp, latitude: null, longitude: null })).toBe(false);
  });
  it('keeps one Termin per place and leaves two different Termine alone', () => {
    const stop = (id: string, base: typeof ramp, appointmentAt: string | null = null) => ({ id, ...base, appointmentAt, appointmentWindowStartAt: null as string | null, appointmentWindowEndAt: null as string | null });
    const moved = shareTerminAtSamePlace([stop('a', ramp), stop('b', ramp, TERMIN)]);
    expect(moved.map((item) => item.appointmentAt)).toEqual([TERMIN, null]);
    expect(shareTerminAtSamePlace([stop('a', ramp, TERMIN), stop('b', ramp, TERMIN)]).map((item) => item.appointmentAt)).toEqual([TERMIN, null]);
    const two = shareTerminAtSamePlace([stop('a', ramp, TERMIN), stop('b', ramp, iso(540))]);
    expect(two.map((item) => item.appointmentAt)).toEqual([TERMIN, iso(540)]);
    expect(withTerminGroups(moved).map((item) => item.terminSharedWithStopId)).toEqual([null, 'a']);
    expect(withTerminGroups(two).map((item) => item.terminSharedWithStopId)).toEqual([null, null]);
    const window = shareTerminAtSamePlace([stop('a', ramp), { ...stop('b', ramp), appointmentWindowStartAt: iso(120), appointmentWindowEndAt: TERMIN }]);
    expect(window[0]).toMatchObject({ appointmentAt: null, appointmentWindowStartAt: iso(120), appointmentWindowEndAt: TERMIN });
    expect(window[1]).toMatchObject({ appointmentWindowStartAt: null, appointmentWindowEndAt: null });
  });
});

describe('a tour with unloading and Leergut at one plant', () => {
  it('stores the Termin once, on the first stop of the place, with no drive between the two', async () => {
    const f = await fixture({ termin: [TERMIN, TERMIN] });
    expect(f.tour.stops.map((stop) => stop.appointmentAt?.toISOString() ?? null)).toEqual([null, TERMIN, null]);
    expect(enrichTour(f.tour, at(30)).stops.map((stop) => stop.terminSharedWithStopId)).toEqual([null, null, f.lead.id]);
    expect(await stored(f.follower.id)).toMatchObject({ appointmentAt: null, terminRequired: false });
    expect(f.tour.legs[1]).toMatchObject({ toStopId: f.follower.id, distanceMeters: 0, routingDurationSeconds: 0 });
    expect(f.routedTo).toHaveLength(1);
    expect(f.routedTo[0]).toMatchObject({ latitude: plant.latitude, longitude: plant.longitude });
  });
  it('moves a Termin entered on the Leergut stop to the unloading stop', async () => {
    const f = await fixture({ termin: [null, TERMIN] });
    expect((await stored(f.lead.id)).appointmentAt).toEqual(new Date(TERMIN));
    expect(await stored(f.follower.id)).toMatchObject({ appointmentAt: null, terminRequired: false });
  });
  it('asks for the Termin of a VW plant once', async () => {
    const f = await fixture({ termin: [null, null] });
    expect((await stored(f.lead.id)).terminRequired).toBe(true);
    expect((await stored(f.follower.id)).terminRequired).toBe(false);
    expect(enrichTour(f.tour, at(30)).stops[2].terminSharedWithStopId).toBe(f.lead.id);
  });
  it('keeps two different Termine as two', async () => {
    const f = await fixture({ termin: [TERMIN, iso(540)] });
    expect((await stored(f.follower.id)).appointmentAt).toEqual(at(540));
    expect(enrichTour(f.tour, at(30)).stops[2].terminSharedWithStopId).toBeNull();
  });
});

describe('a Termin given for the second stop of a place', () => {
  it('is checked and saved on the first one', async () => {
    const f = await fixture({ termin: [null, null] });
    const preview = await f.appointments.preview(f.follower.id, { appointmentAt: TERMIN }, at(30));
    expect(preview).toMatchObject({ stopId: f.lead.id, appliedToStopId: f.lead.id, requestedStopId: f.follower.id, sharedStopIds: [f.follower.id],
      sharedPlace: { sequences: [2, 3], city: 'Salzgitter' } });
    const applied = await f.appointments.apply(f.follower.id, { appointmentAt: TERMIN, version: preview.version }, at(30));
    expect(applied).toMatchObject({ appliedToStopId: f.lead.id, requestedStopId: f.follower.id, sharedStopIds: [f.follower.id], sharedPlace: { sequences: [2, 3] } });
    expect((await stored(f.lead.id)).appointmentAt).toEqual(new Date(TERMIN));
    expect((await stored(f.follower.id)).appointmentAt).toBeNull();
    const events = await db.operationEvent.findMany({ where: { tourId: f.tour.id, type: 'APPOINTMENT_ATTACHED' } });
    expect(events.map((event) => event.stopId)).toEqual([f.lead.id]);
    expect((await db.tour.findUniqueOrThrow({ where: { id: f.tour.id } })).planVersion).toBe(preview.version + 1);
  });
  it('stays on that stop when the dispatcher says it is a separate Termin', async () => {
    const f = await fixture();
    const preview = await f.appointments.preview(f.follower.id, { appointmentAt: iso(540) }, at(30), 'STOP');
    expect(preview).toMatchObject({ stopId: f.follower.id, appliedToStopId: f.follower.id, sharedStopIds: [], sharedPlace: null });
    await f.appointments.apply(f.follower.id, { appointmentAt: iso(540), version: preview.version }, at(30), { scope: 'STOP' });
    expect((await stored(f.lead.id)).appointmentAt).toEqual(new Date(TERMIN));
    expect((await stored(f.follower.id)).appointmentAt).toEqual(at(540));
  });
  it('is not split off while the place has no Termin at all', async () => {
    const f = await fixture({ termin: [null, null] });
    const preview = await f.appointments.preview(f.follower.id, { appointmentAt: TERMIN }, at(30), 'STOP');
    expect(preview).toMatchObject({ appliedToStopId: f.lead.id, sharedStopIds: [f.follower.id] });
  });
  it('goes to the stop itself once the first one is finished: history is not rewritten', async () => {
    const f = await fixture();
    await f.operations.confirmArrival(f.lead.id, at(150), at(151));
    await f.tours.recordUnloaded(f.lead.id, at(240));
    const preview = await f.appointments.preview(f.follower.id, { appointmentAt: iso(540) }, at(250));
    expect(preview).toMatchObject({ appliedToStopId: f.follower.id, sharedStopIds: [], sharedPlace: null });
    await f.appointments.apply(f.follower.id, { appointmentAt: iso(540), version: preview.version }, at(250));
    expect((await stored(f.lead.id)).appointmentAt).toEqual(new Date(TERMIN));
    expect((await stored(f.follower.id)).appointmentAt).toEqual(at(540));
  });
});

describe('lateness is counted once, on arrival at the place', () => {
  const budget = (): DriverBudget => ({
    referenceTime: iso(28), workState: 5, activitySince: iso(0),
    continuousDriveLeftSeconds: 4 * H, breakSeconds: 45 * 60, dailyDriveLeftSeconds: 8 * H, drivenTodaySeconds: 30 * 60, maxDailyDriveSeconds: 9 * H,
    shiftEndAt: iso(13 * 60), restLatestAt: iso(13 * 60), restSeconds: 11 * H,
    weeklyDriveLeftSeconds: 30 * H, extendedShiftsLeft: 1, reducedRestsLeft: 2, earliestNextShiftAt: null, breakRemainingSeconds: 0
  });
  it('shows the delay on the unloading stop only, in both ETA engines, and raises one alert', async () => {
    // Termin 06:00, the truck is still 1.5 h away at 05:30.
    const f = await fixture({ termin: [iso(60), iso(60)] });
    const now = at(30);
    for (const driver of [null, { budget: budget(), startsAt: null }]) {
      const rows = await schedule(f.tour.id, now, driver);
      const [lead, follower] = [rows.find((row) => row.stopId === f.lead.id)!, rows.find((row) => row.stopId === f.follower.id)!];
      expect(lead.deadlineAt).toEqual(at(60));
      expect(lead.predictedDelayMinutes).toBeGreaterThan(0);
      expect(follower).toMatchObject({ deadlineAt: null, appointmentAt: null, predictedDelayMinutes: 0, definiteDelayMinutes: 0 });
      expect(follower.earliestArrival!.getTime()).toBeGreaterThanOrEqual(lead.earliestArrival!.getTime());
    }
    await new AlertService(db as never).refreshVehicleAlerts(f.vehicle.id, await schedule(f.tour.id, now), now);
    const alerts = await db.alert.findMany({ where: { vehicleId: f.vehicle.id } });
    expect(alerts.map((alert) => alert.stopId)).toEqual([f.lead.id]);
  });
  it('settles the Termin when the truck reaches the plant, not again at the Leergut stop', async () => {
    const f = await fixture({ termin: [TERMIN, TERMIN] });
    await f.operations.confirmArrival(f.lead.id, at(200), at(204), undefined, { source: 'WEBFLEET_AUTO' });
    const met = await db.notification.findUniqueOrThrow({ where: { dedupKey: `termin-met:${f.lead.id}` } });
    expect(JSON.parse(met.payloadJson ?? '{}')).toMatchObject({ onTime: false, lateMinutes: 20 });
    await f.tours.recordUnloaded(f.lead.id, at(300));
    await f.operations.confirmArrival(f.follower.id, at(302), at(306), undefined, { source: 'WEBFLEET_AUTO' });
    const notices = await db.notification.findMany({ where: { stopId: f.follower.id } });
    expect(notices.map((notice) => notice.type)).toEqual(['AUTO_ARRIVAL']);
    expect((await stored(f.follower.id)).terminRequired).toBe(false);
    const rows = await schedule(f.tour.id, at(310));
    expect(rows.find((row) => row.stopId === f.follower.id)).toMatchObject({ deadlineAt: null, predictedDelayMinutes: 0 });
  });
  it('does not mark the 07:00 status row as a Termin at risk while the truck loads Leergut', async () => {
    const f = await fixture({ termin: [TERMIN, TERMIN], line: 'SCHNELLECKE' });
    await f.operations.confirmArrival(f.lead.id, at(200), at(204));
    await f.tours.recordUnloaded(f.lead.id, at(300));
    const status = new DailyStatusService(pg(), {
      getPosition: async () => ({ position: { latitude: plant.latitude, longitude: plant.longitude }, positionSource: 'WEBFLEET', telemetryStale: false, remainingDistanceMeters: 0 } as CurrentPosition),
      latestTelemetry: async () => ({ address: 'Industriestraße Nord 1, 38239 Salzgitter, DE', stale: false }),
      driverHours: async () => ({ status: 'NONE', workState: null, activitySince: null, times: null, timesStatus: 'NO_DATA' } as DriverHours),
      coupledTrailerNo: async () => null, webfleetReady: () => true, eta: new EtaService(), startedAt: new Date('2026-11-03T00:00:00Z')
    });
    const list = await status.generate('2026-11-03', at(310), { role: 'dispatcher', sessionId: 's' });
    const row = list.rows.find((item) => item.vehicleNumber === f.vehicle.vehicleNumber)!;
    expect(row).toBeDefined();
    expect(row.flags).not.toContain('TERMIN_AT_RISK');
  });
});

describe('Termin slip, assistant and replanning', () => {
  const blank = { documentType: null, plate: null, trailerPlate: null, company: null, site: null, city: null, stopType: null, appointmentLocal: null,
    windowStartLocal: null, windowEndLocal: null, appointmentDateLocal: null, standgeldFromLocal: null, references: [], positions: [], sourceExcerpt: null, confidence: 0.9 };
  const slip = (extra: Partial<AppointmentDocument>): AppointmentDocument => ({ kind: 'VW_FAHRTENSCHEIN', ...blank, warnings: [], ...extra } as AppointmentDocument);

  it('matches a slip of the plant to the unloading stop instead of asking which of the two', async () => {
    const f = await fixture({ termin: [null, null] });
    const match = await matchAppointment(pg(), slip({ plate: f.vehicle.licensePlate, company: 'Volkswagen AG', city: 'Salzgitter', appointmentLocal: '2026-11-03T08:00' }));
    expect(match.vehicle).toMatchObject({ status: 'MATCHED', vehicleId: f.vehicle.id });
    expect(match.status).toBe('MATCHED');
    expect(match.candidates.map((candidate) => candidate.stopId)).toEqual([f.lead.id]);
    // A slip that names the loading keeps its reasons, but still lands on the stop that holds the Termin of the place.
    const loading = await matchAppointment(pg(), slip({ plate: f.vehicle.licensePlate, company: 'Volkswagen AG', city: 'Salzgitter', stopType: 'LOAD', appointmentLocal: '2026-11-03T08:00' }));
    expect(loading.candidates.map((candidate) => candidate.stopId)).toEqual([f.lead.id]);
    expect(loading.candidates[0].reasons).toContain('загрузка');
  });
  it('keeps both stops as candidates when the Leergut stop has its own Termin', async () => {
    const f = await fixture({ termin: [TERMIN, iso(540)] });
    const match = await matchAppointment(pg(), slip({ plate: f.vehicle.licensePlate, company: 'Volkswagen AG', city: 'Salzgitter', appointmentLocal: '2026-11-03T08:00' }));
    expect(match.candidates.map((candidate) => candidate.stopId).sort()).toEqual([f.lead.id, f.follower.id].sort());
  });
  it('plans the Termin of the place when the assistant is asked about the Leergut stop', async () => {
    const f = await fixture({ termin: [null, null] });
    const position = { position: { latitude: 51.5, longitude: 11.4 }, positionSource: 'WEBFLEET', telemetryStale: false, remainingDistanceMeters: 100_000 } as CurrentPosition;
    const hours = { status: 'NONE', workState: null, activitySince: null, times: null, timesStatus: 'NO_DATA' } as DriverHours;
    const service = new TerminService(pg(), f.routing, async () => position, async () => hours);
    expect((await service.plan({ stopId: f.follower.id }, f.vehicle.id, at(30))).target.stopId).toBe(f.lead.id);
    expect((await service.plan({}, f.vehicle.id, at(30))).target.stopId).toBe(f.lead.id);
    await f.appointments.apply(f.lead.id, { appointmentAt: TERMIN, version: f.tour.planVersion }, at(30));
    // With the Termin of the place in, nothing is left to ask for: the Leergut stop is not offered a second one.
    expect((await service.plan({}, f.vehicle.id, at(30))).target.stopId).toBe(f.lead.id);
  });
  it('keeps one Termin when the rest of the tour is replanned', async () => {
    const f = await fixture({ termin: [null, null] });
    const service = new ReplanningService(asAppDatabase(db), f.routing);
    const futureStops = [
      { id: f.lead.id, ...plant },
      { id: f.follower.id, ...leergut, appointmentAt: TERMIN }
    ];
    const preview = await service.preview(f.tour.id, { version: f.tour.planVersion, futureStops }, at(30));
    const result = await service.apply(f.tour.id, { previewId: preview.id, version: f.tour.planVersion }, at(30));
    const open = result.stops.filter((stop) => !stop.completedAt);
    expect(open.map((stop) => stop.appointmentAt?.toISOString() ?? null)).toEqual([TERMIN, null]);
  });
});
