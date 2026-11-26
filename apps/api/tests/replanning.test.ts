import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { forecastQueue, ReplanningService, replanStopsSchema } from '../src/services/replanning.js';
import { ClockEngine, forecastEta, WebfleetEngine, type DriverBudget } from '../src/services/termin-planner.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';
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
  return { vehicle, tour, load, unload, leg, route, service: new ReplanningService(asAppDatabase(db), routing) };
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
  await db.operationEvent.create({ data: { vehicleId: f.vehicle.id, type: 'CLOCK_CORRECTION', payloadJson: '{}', reason: 'Tachograph korrigiert' } });
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

it('a background traffic refresh between preview and apply does not void the preview', async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.tour.id, { version: 0, futureStops: [replacement] }, now);
  // What the 15 s traffic job does to a moving truck: new leg details, plan and vehicle versions, a TRAFFIC_REFRESH event.
  await db.leg.update({ where: { id: f.leg.id }, data: { routeDetails: JSON.stringify({ checkedAt: now.toISOString(), refreshIntervalSeconds: 300 }) } });
  await db.tour.update({ where: { id: f.tour.id }, data: { planVersion: { increment: 1 } } });
  await db.vehicle.update({ where: { id: f.vehicle.id }, data: { operationVersion: { increment: 1 } } });
  await db.operationEvent.create({ data: { vehicleId: f.vehicle.id, tourId: f.tour.id, type: 'TRAFFIC_REFRESH', payloadJson: '{}' } });
  const result = await f.service.apply(f.tour.id, { previewId: preview.id, version: 0 }, now);
  expect(result.stops.at(-1)).toMatchObject({ address: 'Kassel' });
});

it('a changed stop still voids the preview', async () => {
  const f = await fixture();
  const preview = await f.service.preview(f.tour.id, { version: 0, futureStops: [replacement] }, now);
  await db.stop.update({ where: { id: f.unload.id }, data: { address: 'Hamburg Hafen' } });
  await expect(f.service.apply(f.tour.id, { previewId: preview.id, version: 0 }, now)).rejects.toMatchObject({ statusCode: 409 });
});

it('«Изменить тур» accepts the stops as the page sends them: an unloading is added to a running tour whose stop has no company (19.11)', async () => {
  const f = await fixture();
  // The stop of the tour comes with the empty fields it has in the base; the new one has no id and no coordinates yet.
  const sent = [
    { id: f.unload.id, type: 'UNLOAD', address: 'Hamburg', company: null, city: null, appointmentAt: null, instructions: null, serviceMinMinutes: 60, serviceMaxMinutes: 120, latitude: 53.5, longitude: 10 },
    { type: 'UNLOAD', address: 'Kassel', company: '', city: '34117 Kassel', appointmentAt: null, latitude: null, longitude: null }
  ];
  const futureStops = replanStopsSchema.parse(sent);
  expect(futureStops[0]).toMatchObject({ id: f.unload.id, company: null, city: null });
  expect(futureStops[1]).toMatchObject({ company: null, city: '34117 Kassel' });
  expect(futureStops[1].id).toBeUndefined();
  expect(futureStops[1].latitude).toBeUndefined();
  const preview = await f.service.preview(f.tour.id, { version: 0, futureStops: [futureStops[0], { ...futureStops[1], latitude: 51.3, longitude: 9.5 }] }, now);
  expect(preview.stops).toHaveLength(2);
  // What the page must never send is still refused.
  expect(() => replanStopsSchema.parse([{ type: 'UNLOAD', address: ' ' }])).toThrow();
  expect(() => replanStopsSchema.parse([{ type: 'PARK', address: 'Kassel' }])).toThrow();
  expect(() => replanStopsSchema.parse([])).toThrow();
});

async function queue(f: Awaited<ReturnType<typeof fixture>>) {
  const middle = await db.tour.create({ data: { vehicleId: f.vehicle.id, orderNumber: 'Q1', status: 'QUEUED', previousTourId: f.tour.id, queueIndex: 1 } });
  const pick = await db.stop.create({ data: { tourId: middle.id, sequence: 1, type: 'LOAD', address: 'Bremen', latitude: 53, longitude: 8 } });
  const drop = await db.stop.create({ data: { tourId: middle.id, sequence: 2, type: 'UNLOAD', address: 'Hannover', latitude: 52.4, longitude: 9.7 } });
  const leg = { distanceMeters: 1000, routingDurationSeconds: 600, simulatedDurationSeconds: 600, routeGeometry: '[]' };
  await db.leg.create({ data: { ...leg, tourId: middle.id, fromStopId: f.unload.id, toStopId: pick.id } });
  await db.leg.create({ data: { ...leg, tourId: middle.id, fromStopId: pick.id, toStopId: drop.id } });
  const last = await db.tour.create({ data: { vehicleId: f.vehicle.id, orderNumber: 'Q2', status: 'QUEUED', previousTourId: middle.id, queueIndex: 2 } });
  const far = await db.stop.create({ data: { tourId: last.id, sequence: 1, type: 'UNLOAD', address: 'Dortmund', latitude: 51.5, longitude: 7.5 } });
  await db.leg.create({ data: { ...leg, tourId: last.id, fromStopId: drop.id, toStopId: far.id } });
  return { middle, pick, drop, last, far };
}

it('a tour waiting in the queue is edited like the running one, in the middle of the queue too (owner, 26.11)', async () => {
  const f = await fixture();
  const q = await queue(f);
  const before = await db.vehicle.findUniqueOrThrow({ where: { id: f.vehicle.id } });
  const keep = { id: q.pick.id, type: 'LOAD' as const, address: 'Bremen', latitude: 53, longitude: 8 };
  const preview = await f.service.preview(q.middle.id, { version: 0, futureStops: [keep, replacement] }, now);
  // Timed after the running tour, shown only for its own stops and the tour behind it.
  expect(preview.etaWindows.map(w => w.stopId)).toEqual([q.pick.id, preview.stops[1].id, q.far.id]);
  expect(Date.parse(preview.etaWindows[0].earliest)).toBeGreaterThan(now.getTime() + 3600 * 1000);
  expect(preview.affectedTourIds).toEqual([q.middle.id, q.last.id]);
  await f.service.apply(q.middle.id, { previewId: preview.id, version: 0 }, now);

  const stops = await db.stop.findMany({ where: { tourId: q.middle.id }, orderBy: { sequence: 'asc' } });
  expect(stops.map(s => s.address)).toEqual(['Bremen', 'Kassel']);
  expect(await db.stop.findUnique({ where: { id: q.drop.id } })).toBeNull();
  const own = await db.leg.findMany({ where: { tourId: q.middle.id } });
  expect(own.map(l => [l.fromStopId, l.toStopId])).toEqual([[f.unload.id, q.pick.id], [q.pick.id, stops[1].id]]);
  const handover = await db.leg.findMany({ where: { tourId: q.last.id } });
  expect(handover.map(l => [l.fromStopId, l.toStopId])).toEqual([[stops[1].id, q.far.id]]);
  // The leg the truck drives now and its clock stay as they were.
  expect(await db.leg.findUniqueOrThrow({ where: { id: f.leg.id } })).toMatchObject({ status: 'ACTIVE', startedAt: now, toStopId: f.unload.id });
  expect((await db.vehicle.findUniqueOrThrow({ where: { id: f.vehicle.id } })).clockState).toBe(before.clockState);
  expect(await db.tour.findUniqueOrThrow({ where: { id: q.middle.id } })).toMatchObject({ status: 'QUEUED', planVersion: 1 });
});

it('a queued tour something already happened at is not edited here', async () => {
  const f = await fixture();
  const q = await queue(f);
  await db.stop.update({ where: { id: q.pick.id }, data: { arrivedAt: now } });
  await expect(f.service.preview(q.middle.id, { version: 0, futureStops: [replacement] }, now)).rejects.toMatchObject({ statusCode: 409 });
  await db.stop.update({ where: { id: q.pick.id }, data: { arrivedAt: null } });
  await db.tour.update({ where: { id: q.middle.id }, data: { status: 'CANCELLED' } });
  await expect(f.service.preview(q.middle.id, { version: 0, futureStops: [replacement] }, now)).rejects.toMatchObject({ statusCode: 409 });
});

const H = 3600;
const budget = (continuousLeftSeconds: number): DriverBudget => ({
  referenceTime: now.toISOString(), workState: 3, activitySince: now.toISOString(),
  continuousDriveLeftSeconds: continuousLeftSeconds, breakSeconds: 45 * 60, dailyDriveLeftSeconds: 9 * H, drivenTodaySeconds: 0, maxDailyDriveSeconds: 9 * H,
  shiftEndAt: new Date(now.getTime() + 13 * H * 1000).toISOString(), restLatestAt: null, restSeconds: 11 * H,
  weeklyDriveLeftSeconds: 50 * H, extendedShiftsLeft: 2, reducedRestsLeft: 3, earliestNextShiftAt: null, breakRemainingSeconds: 0
});

it('«Изменить тур» times the stops on the driver\'s tachograph, as the tour\'s ETA does (owner, 19.11)', async () => {
  // Two hours to the stop: a rested clock drives straight through; a driver with 30 min left before the break stops for 45 min.
  const legs = [{ toStopId: 'a', duration: 2 * H }, { toStopId: 'b', duration: H }];
  const stops = [{ id: 'a', serviceMinMinutes: 60, serviceMaxMinutes: 120 }, { id: 'b' }];
  const rested = forecastQueue(new ClockEngine(createInitialClockState({ effectiveAt: now })), now, legs, stops);
  expect(rested[0].earliest).toBe(new Date(now.getTime() + 2 * H * 1000).toISOString());
  const tired = forecastQueue(new WebfleetEngine(budget(30 * 60)), now, legs, stops);
  expect(tired[0].earliest).toBe(new Date(now.getTime() + (2 * H + 45 * 60) * 1000).toISOString());
  // The hour at the stop counts as the break, so the next leg needs none; the late side stays two hours.
  expect(tired[1].earliest).toBe(new Date(now.getTime() + (2 * H + 45 * 60 + H + H) * 1000).toISOString());
  expect(tired[1].latest).toBe(new Date(now.getTime() + (2 * H + 45 * 60 + 2 * H + H) * 1000).toISOString());
  // A driver whose card is out starts with the next shift.
  const later = new Date(now.getTime() + 8 * H * 1000);
  expect(forecastQueue(new WebfleetEngine(budget(4.5 * H)), now, legs, stops, undefined, later)[0].earliest).toBe(new Date(later.getTime() + 2 * H * 1000).toISOString());

  const f = await fixture();
  const withDriver = new ReplanningService(asAppDatabase(db), new MockRoutingProvider(), undefined, undefined, async () => ({ budget: budget(10 * 60), startsAt: null }));
  const preview = await withDriver.preview(f.tour.id, { version: 0, futureStops: [replacement] }, now);
  const drive = preview.after.durationSeconds;
  expect(drive).toBeGreaterThan(10 * 60);
  // Ten minutes before the break and about 7 h 30 of driving: two breaks of 45 min on the way.
  expect(preview.etaWindows[0].earliest).toBe(forecastEta(new WebfleetEngine(budget(10 * 60)), drive, now, null).endAt.toISOString());
  expect(Date.parse(preview.etaWindows[0].earliest) - now.getTime()).toBeGreaterThanOrEqual((drive + 45 * 60) * 1000);
});
