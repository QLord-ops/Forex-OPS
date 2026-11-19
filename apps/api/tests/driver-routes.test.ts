import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { driverGpsCheck, registerDriverRoutes } from '../src/routes/driver.js';
import { registerDispatcherAuth, type DispatcherAuthOptions } from '../src/services/dispatcher-auth.js';
import { issueDriverShift, registerDriverAuth } from '../src/services/driver-auth.js';
import { prioritize } from '../src/services/notification-priority.js';
import { OperationsService } from '../src/services/operations.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { DRIVER_UNDO_MS, TourService } from '../src/services/tours.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

const CAB = 'https://fahrer.test';
const secret = 's'.repeat(32);
const PLANT = { latitude: 52.1503, longitude: 10.4058 };
const WOLFSBURG = { latitude: 52.4227, longitude: 10.7865 };
let directory: string;
let db: PrismaClient;
// Marks may not lie in the future of the real clock, so the test clock starts in the past.
let now = Date.now() - 6 * 3_600_000;
let gps: { latitude: number; longitude: number; stale: boolean; ageSeconds: number } | null = { ...PLANT, stale: false, ageSeconds: 60 };
let trucks = 0;

async function scenario() {
  const number = String(900 + ++trucks);
  const pg = asAppDatabase(db);
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: number, licensePlate: `GÖ-FX ${number}` } });
  const tours = new TourService(pg, new MockRoutingProvider());
  const operations = new OperationsService(pg, tours);
  const plant = { company: 'Volkswagen AG', address: `Industriestraße Nord ${trucks}, 38239 Salzgitter`, city: '38239 Salzgitter', ...PLANT };
  const tour = await tours.createTour({ vehicleId: vehicle.id, orderNumber: `A-${number}`, tourRemarks: 'Anmeldung an Pforte 3', stops: [
    { sequence: 1, type: 'UNLOAD', ...plant, appointmentAt: new Date(now + 3_600_000).toISOString(), loadingMeters: 13.6, referenceNumbers: ['4500812331'], instructions: 'Halle 7' },
    { sequence: 2, type: 'LOAD', ...plant },
    { sequence: 3, type: 'UNLOAD', company: 'Schnellecke Logistics', address: 'Heinrich-Nordhoff-Straße 1, 38440 Wolfsburg', city: '38440 Wolfsburg', ...WOLFSBURG }
  ] });

  const app = Fastify();
  let driverGate: NonNullable<DispatcherAuthOptions['driverGate']> | undefined;
  registerDispatcherAuth(app, db as never, { secret, origins: ['https://ops.test'], now: () => now, driverGate: (request, reply) => driverGate!(request, reply) });
  driverGate = registerDriverAuth(app, pg, { secret, origins: [CAB], now: () => now });
  const afterEvents: string[][] = [];
  registerDriverRoutes(app, { prisma: pg, tours, operations, now: () => new Date(now), gps: async () => gps,
    eta: async () => ({ at: new Date(now + 1_800_000).toISOString(), source: 'WEBFLEET' }), afterEvent: async (_vehicleId, stopIds) => { afterEvents.push(stopIds); } });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500;
    reply.status(status).send({ error: error instanceof Error ? error.message : 'error' });
  });
  await app.ready();
  const { code } = await issueDriverShift(pg, vehicle.id, 24, { role: 'admin', sessionId: 'test' }, new Date(now));
  const login = await app.inject({ method: 'POST', url: '/driver/auth/login', headers: { origin: CAB }, payload: { vehicle: number, code } });
  const headers = { origin: CAB, cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken as string };
  const post = (path: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: path, headers, payload });
  return { app, vehicle, tours, tour, headers, post, afterEvents, stops: tour.stops };
}

const closing: FastifyInstance[] = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-driver-routes-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => {
  await Promise.all(closing.map(app => app.close()));
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('driver app: the tour and the driver\'s own marks', () => {
  it('shows only the tour of the truck the phone is signed in for', async () => {
    const mine = await scenario(); const other = await scenario();
    closing.push(mine.app, other.app);
    const view = (await mine.app.inject({ url: '/driver/tour', headers: mine.headers })).json();
    expect(view.vehicle).toEqual({ vehicleNumber: mine.vehicle.vehicleNumber, licensePlate: mine.vehicle.licensePlate });
    expect(view.tour).toMatchObject({ orderNumber: mine.tour.orderNumber, tourRemarks: 'Anmeldung an Pforte 3', currentStopId: mine.stops[0].id, eta: { source: 'WEBFLEET' } });
    expect(view.tour.stops).toHaveLength(3);
    expect(view.tour.stops[0]).toMatchObject({ type: 'UNLOAD', company: 'Volkswagen AG', loadingMeters: 13.6, references: ['4500812331'], instructions: 'Halle 7', arrivedAt: null, completedAt: null, samePlaceAsPrevious: false, undoUntil: null });
    expect(view.tour.stops[1]).toMatchObject({ type: 'LOAD', samePlaceAsPrevious: true });
    expect(view.tour.stops[2]).toMatchObject({ samePlaceAsPrevious: false });
    expect(JSON.stringify(view)).not.toContain(other.tour.orderNumber);

    expect((await mine.app.inject({ url: '/driver/tour' })).statusCode).toBe(401);
    for (const action of ['arrived', 'done', 'undo']) {
      expect((await mine.post(`/driver/stops/${other.stops[0].id}/${action}`)).statusCode).toBe(404);
    }
    expect((await mine.post(`/driver/stops/${other.stops[0].id}/problem`, { kind: 'OTHER' })).statusCode).toBe(404);
    expect(await db.stop.findUniqueOrThrow({ where: { id: other.stops[0].id } })).toMatchObject({ arrivedAt: null, completedAt: null });
  });

  it('records «Прибыл» and ENTLADEN as real events from the driver and tells the dispatcher', async () => {
    const { app, vehicle, post, stops, afterEvents } = await scenario();
    closing.push(app);
    const [unload, leergut] = stops;
    const early = await post(`/driver/stops/${unload.id}/done`);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe('Сначала нажмите «Прибыл».');

    now += 60_000;
    const arrivedAt = new Date(now);
    const arrived = await post(`/driver/stops/${unload.id}/arrived`);
    expect(arrived.statusCode).toBe(200);
    expect(arrived.json().tour.stops[0].arrivedAt).toBe(arrivedAt.toISOString());
    const arrivalNote = await db.notification.findUniqueOrThrow({ where: { dedupKey: `driver-arrival:${unload.id}` } });
    expect(arrivalNote).toMatchObject({ type: 'DRIVER_ARRIVAL', vehicleId: vehicle.id, acknowledgedAt: null });
    expect(arrivalNote.message).toContain(`Водитель LKW ${vehicle.vehicleNumber} отметил прибытие на выгрузку`);
    expect(arrivalNote.message).toContain('Webfleet: машина в зоне точки (GPS 1 мин).');
    const arrival = await db.operationEvent.findFirstOrThrow({ where: { stopId: unload.id, type: 'ARRIVAL_CONFIRMED' } });
    expect(JSON.parse(arrival.payloadJson)).toMatchObject({ source: 'DRIVER', gps: { status: 'IN_ZONE' } });
    // A second tap changes nothing.
    await post(`/driver/stops/${unload.id}/arrived`);
    expect(await db.operationEvent.count({ where: { stopId: unload.id, type: 'ARRIVAL_CONFIRMED' } })).toBe(1);

    now += 30 * 60_000;
    const doneAt = new Date(now);
    const done = await post(`/driver/stops/${unload.id}/done`);
    expect(done.statusCode).toBe(200);
    expect(done.json().tour).toMatchObject({ currentStopId: leergut.id });
    expect(done.json().tour.stops[0]).toMatchObject({ completedAt: doneAt.toISOString(), undoUntil: new Date(now + DRIVER_UNDO_MS).toISOString() });
    expect(await db.event.findFirstOrThrow({ where: { stopId: unload.id } })).toMatchObject({ type: 'UNLOADED', source: 'DRIVER', timestamp: doneAt, note: 'Отмечено водителем в приложении' });
    const note = await db.notification.findFirstOrThrow({ where: { stopId: unload.id, type: 'DRIVER_STOP_EVENT' } });
    expect(note.message).toContain(`Водитель LKW ${vehicle.vehicleNumber} отметил ENTLADEN`);
    expect(note.message).toContain('Volkswagen AG, 38239 Salzgitter');
    expect(JSON.parse(note.payloadJson)).toMatchObject({ source: 'DRIVER', stopType: 'UNLOAD', gps: { status: 'IN_ZONE' } });
    const audit = await db.auditLog.findMany({ where: { stopId: unload.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map(row => `${row.actorRole}:${row.action}`)).toEqual(['driver:ARRIVAL_CONFIRMED', 'driver:UNLOADED']);
    expect(afterEvents.at(-1)).toEqual([unload.id]);
    expect((await post(`/driver/stops/${unload.id}/done`)).statusCode).toBe(409);

    // Leergut at the same plant: no drive, no «Прибыл» — the arrival comes with BELADEN.
    now += 20 * 60_000;
    const loaded = await post(`/driver/stops/${leergut.id}/done`);
    expect(loaded.statusCode).toBe(200);
    expect(await db.stop.findUniqueOrThrow({ where: { id: leergut.id } })).toMatchObject({ arrivedAt: new Date(now), completedAt: new Date(now) });
    expect(await db.event.findFirstOrThrow({ where: { stopId: leergut.id } })).toMatchObject({ type: 'LOADED', source: 'DRIVER' });
    // The next stop is another town: there the driver has to arrive first.
    expect((await post(`/driver/stops/${stops[2].id}/done`)).statusCode).toBe(409);
  });

  it('lets the driver take a mark back for five minutes, and the dispatcher afterwards', async () => {
    const { app, post, stops, tours } = await scenario();
    closing.push(app);
    const [unload] = stops;
    now += 60_000;
    await post(`/driver/stops/${unload.id}/arrived`);
    const arrivedAt = new Date(now);
    now += 20 * 60_000;
    await post(`/driver/stops/${unload.id}/done`);

    now += 4 * 60_000;
    const undone = await post(`/driver/stops/${unload.id}/undo`);
    expect(undone.statusCode).toBe(200);
    expect(undone.json().tour).toMatchObject({ currentStopId: unload.id });
    expect(undone.json().tour.stops[0]).toMatchObject({ completedAt: null, arrivedAt: arrivedAt.toISOString(), undoUntil: null });
    // History stays: the mark and its compensation are both there.
    const events = await db.event.findMany({ where: { stopId: unload.id }, orderBy: { timestamp: 'asc' } });
    expect(events.map(event => `${event.type}:${event.source}`)).toEqual(['UNLOADED:DRIVER', 'UNLOADED_REVERTED:DRIVER']);
    expect(events[1].note).toBe('Отметка отменена водителем в приложении');
    expect(await db.notification.count({ where: { stopId: unload.id, type: 'DRIVER_STOP_EVENT', acknowledgedAt: null } })).toBe(0);
    expect((await post(`/driver/stops/${unload.id}/undo`)).statusCode).toBe(409);

    now += 60_000;
    await post(`/driver/stops/${unload.id}/done`);
    now += DRIVER_UNDO_MS + 1000;
    const late = await post(`/driver/stops/${unload.id}/undo`);
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('Отменить отметку можно в течение 5 минут. Позвоните диспетчеру.');
    expect((await db.stop.findUniqueOrThrow({ where: { id: unload.id } })).completedAt).not.toBeNull();

    await tours.revertAutoStopEvent(unload.id, new Date(now), { role: 'dispatcher', sessionId: 'office' });
    expect((await db.stop.findUniqueOrThrow({ where: { id: unload.id } })).completedAt).toBeNull();
    const last = await db.event.findFirstOrThrow({ where: { stopId: unload.id }, orderBy: { timestamp: 'desc' } });
    expect(last).toMatchObject({ type: 'UNLOADED_REVERTED', source: 'DISPATCHER', note: 'Отметка водителя отменена диспетчером' });
  });

  it('still lets the driver take back the mark that closed the tour', async () => {
    const { app, post, stops, tour, vehicle, tours } = await scenario();
    closing.push(app);
    const queued = await tours.createTour({ vehicleId: vehicle.id, orderNumber: `${tour.orderNumber}-NEXT`, stops: [
      { sequence: 1, type: 'LOAD', company: 'Forex Lager', address: 'Mühlenweg 78, 37120 Bovenden', city: '37120 Bovenden', latitude: 51.59, longitude: 9.93 },
      { sequence: 2, type: 'UNLOAD', company: 'Kunde', address: 'Hafenstraße 1, 20457 Hamburg', city: '20457 Hamburg', latitude: 53.54, longitude: 9.98 }
    ] });
    let last = null as null | Awaited<ReturnType<typeof post>>;
    for (const stop of stops) {
      now += 60_000;
      // The Leergut stop at the same plant needs no arrival of its own.
      if (stop.id !== stops[1].id) await post(`/driver/stops/${stop.id}/arrived`);
      now += 60_000;
      last = await post(`/driver/stops/${stop.id}/done`);
      expect(last.statusCode).toBe(200);
    }
    // The phone now shows the next tour, and the mark that closed the old one.
    expect(last!.json()).toMatchObject({ tour: { orderNumber: queued.orderNumber },
      lastMark: { stopId: stops[2].id, type: 'UNLOAD', orderNumber: tour.orderNumber, undoUntil: new Date(now + DRIVER_UNDO_MS).toISOString() } });
    expect(await db.tour.findUniqueOrThrow({ where: { id: tour.id } })).toMatchObject({ status: 'COMPLETED' });
    expect(await db.tour.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'ACTIVE' });

    const undone = await post(`/driver/stops/${stops[2].id}/undo`);
    expect(undone.statusCode).toBe(200);
    expect(undone.json()).toMatchObject({ lastMark: null, tour: { orderNumber: tour.orderNumber, currentStopId: stops[2].id } });
    expect(await db.tour.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'QUEUED' });
  });

  it('never takes back a dispatcher\'s mark from the phone, and marks the dispatcher\'s own events as such', async () => {
    const { app, post, stops, tours } = await scenario();
    closing.push(app);
    now += 60_000;
    await post(`/driver/stops/${stops[0].id}/arrived`);
    now += 60_000;
    await tours.recordUnloaded(stops[0].id, new Date(now), undefined, { role: 'dispatcher', sessionId: 'office' });
    expect(await db.event.findFirstOrThrow({ where: { stopId: stops[0].id } })).toMatchObject({ source: 'DISPATCHER' });
    expect((await post(`/driver/stops/${stops[0].id}/undo`)).statusCode).toBe(409);
    expect((await db.stop.findUniqueOrThrow({ where: { id: stops[0].id } })).completedAt).not.toBeNull();
  });

  it('records the mark even when Webfleet sees the truck elsewhere, and says so to the dispatcher', async () => {
    const { app, post, stops } = await scenario();
    closing.push(app);
    gps = { latitude: PLANT.latitude + 0.11, longitude: PLANT.longitude, stale: false, ageSeconds: 120 };
    try {
      now += 60_000;
      await post(`/driver/stops/${stops[0].id}/arrived`);
      now += 60_000;
      expect((await post(`/driver/stops/${stops[0].id}/done`)).statusCode).toBe(200);
    } finally { gps = { ...PLANT, stale: false, ageSeconds: 60 }; }
    const note = await db.notification.findFirstOrThrow({ where: { stopId: stops[0].id, type: 'DRIVER_STOP_EVENT' } });
    expect(note.message).toMatch(/Webfleet: машина в 12,\d км от точки \(GPS 2 мин\) — проверьте\./);
    const stop = await db.stop.findUniqueOrThrow({ where: { id: stops[0].id } });
    const facts = { stops: new Map([[stop.id, stop]]), legTarget: new Map<string, string>() };
    expect(prioritize([note], facts, new Date(now))[0]).toMatchObject({ priority: 'RISK', resolved: false });
  });

  it('judges the mark by Webfleet only: zone, away, stale or no position', () => {
    const stop = { ...PLANT, arrivalRadiusMeters: null };
    expect(driverGpsCheck({ ...PLANT, stale: false, ageSeconds: 30 }, stop)).toEqual({ status: 'IN_ZONE', distanceMeters: 0, ageMinutes: 1 });
    expect(driverGpsCheck({ latitude: PLANT.latitude + 0.02, longitude: PLANT.longitude, stale: false, ageSeconds: 0 }, stop).status).toBe('AWAY');
    expect(driverGpsCheck({ latitude: PLANT.latitude + 0.02, longitude: PLANT.longitude, stale: false, ageSeconds: 0 }, { ...stop, arrivalRadiusMeters: 3000 }).status).toBe('IN_ZONE');
    expect(driverGpsCheck({ ...PLANT, stale: true, ageSeconds: 3600 }, stop)).toMatchObject({ status: 'STALE', ageMinutes: 60 });
    expect(driverGpsCheck(null, stop)).toEqual({ status: 'NONE', distanceMeters: null, ageMinutes: null });
  });

  it('passes a problem at the stop to the dispatcher as a decision', async () => {
    const { app, vehicle, post, stops } = await scenario();
    closing.push(app);
    expect((await post(`/driver/stops/${stops[0].id}/problem`, { kind: 'FLAT_TYRE' })).statusCode).toBe(400);
    expect((await post(`/driver/stops/${stops[0].id}/problem`, { kind: 'WAITING', note: 'x'.repeat(301) })).statusCode).toBe(400);
    const sent = await post(`/driver/stops/${stops[0].id}/problem`, { kind: 'WAITING', note: 'Rampe besetzt' });
    expect(sent.json()).toEqual({ ok: true });
    const note = await db.notification.findFirstOrThrow({ where: { stopId: stops[0].id, type: 'DRIVER_PROBLEM' } });
    expect(note.message).toBe(`Водитель LKW ${vehicle.vehicleNumber} сообщает о проблеме на точке Volkswagen AG, 38239 Salzgitter: долгое ожидание — «Rampe besetzt». Свяжитесь с водителем.`);
    expect(await db.auditLog.count({ where: { stopId: stops[0].id, action: 'DRIVER_PROBLEM_REPORTED', actorRole: 'driver' } })).toBe(1);
    const facts = { stops: new Map(), legTarget: new Map<string, string>() };
    expect(prioritize([note], facts, new Date(now))[0]).toMatchObject({ priority: 'ACTION', urgent: true });
  });
});
