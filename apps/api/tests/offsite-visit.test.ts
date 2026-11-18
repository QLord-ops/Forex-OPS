import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { LearnedGates } from '../src/services/learned-gates.js';
import { OperationsService, SYSTEM_WEBFLEET_ACTOR } from '../src/services/operations.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { placeKey, StayPlaces, stayExternalId, STAY_SOURCE } from '../src/services/stay-places.js';
import { TourService } from '../src/services/tours.js';
import { distanceMeters, pickOffsiteStay, standstillsOf, WebfleetTelemetryService } from '../src/services/webfleet.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

// Tesla Grünheide (owner, 18.11): the address of the Auftrag and the gate where the trucks really stand are 2 km apart.
const ADDRESS_POINT = { latitude: 52.3925, longitude: 13.7905 };
// The door of the stops planned for the learned-gate tests; the GPS scenarios each get their own house number.
const ADDRESS = 'Gigastraße 1, 15537 Grünheide';
const north = (meters: number) => ({ latitude: ADDRESS_POINT.latitude + meters / 111_000, longitude: ADDRESS_POINT.longitude });
const GATE = north(2000);
const HAMBURG = { latitude: 53.55, longitude: 9.99 };
const at = (minute: number, day = 0) => new Date(Date.UTC(2026, 10, 18 + day, 8, minute));

let directory: string;
let db: PrismaClient;
const pg = () => db as unknown as PostgresPrismaClient;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-offsite-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

/** A truck that loads at Tesla Grünheide and unloads in Hamburg, wired like the server: GPS → offsite visit → event and learning. */
let houses = 0;
async function scenario(name: string, options: { day?: number; plannedAt?: Date; leergut?: boolean } = {}) {
  // Every truck loads at its own door, so that one test's stays never teach another test's place.
  const address = `Tesla Straße ${++houses}, 15537 Grünheide`;
  const owner = await db.dispatcher.create({ data: { login: `d-${name.toLowerCase()}`, displayName: `Disponent ${name}`, passwordHash: 'x' } });
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: name, licensePlate: `B-${name}`, assignedDispatcherId: owner.id } });
  const tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const tour = await tours.createTour({ vehicleId: vehicle.id, orderNumber: `ORD-${name}`, stops: [
    ...(options.leergut ? [
      { sequence: 1, type: 'UNLOAD' as const, company: 'Tesla Manufacturing Brandenburg SE', address, city: '15537 Grünheide', ...ADDRESS_POINT },
      { sequence: 2, type: 'LOAD' as const, company: 'Tesla Manufacturing Brandenburg SE', address, city: '15537 Grünheide', ...ADDRESS_POINT }
    ] : [{ sequence: 1, type: 'LOAD' as const, company: 'Tesla Manufacturing Brandenburg SE', address, city: '15537 Grünheide', ...ADDRESS_POINT,
      ...(options.plannedAt ? { plannedAt: options.plannedAt.toISOString() } : {}) }]),
    { sequence: options.leergut ? 3 : 2, type: 'UNLOAD' as const, address: 'Hamburg', city: 'Hamburg', ...HAMBURG }
  ] });
  const operations = new OperationsService(asAppDatabase(db), tours);
  const places = new StayPlaces(pg());
  const telemetry = new WebfleetTelemetryService(pg(),
    (input) => operations.confirmArrival(input.stopId, input.arrivedAt, input.now, SYSTEM_WEBFLEET_ACTOR, { source: 'WEBFLEET_AUTO', meta: input.meta }),
    (input) => tours.recordAutoStopEvent(input, SYSTEM_WEBFLEET_ACTOR),
    { gates: (stopId) => places.gatesOf(stopId),
      record: async (input) => { const result = await tours.recordAutoStopEvent(input, SYSTEM_WEBFLEET_ACTOR); await places.learnOffsiteVisit(input.chainStopIds ?? [input.stopId], input.meta.offsite, input.arrivedAt, input.now); return result; } });
  const day = options.day ?? 0;
  const feed = (minute: number, point: { latitude: number; longitude: number }, standstill: boolean) =>
    telemetry.applyPosition({ objectUid: `wf-${name}`, objectNo: name, ...point, standstill, recordedAt: at(minute, day) }, new Date(at(minute, day).getTime() + 30_000));
  const stand = async (from: number, to: number, point: { latitude: number; longitude: number }) => { for (let minute = from; minute <= to; minute += 1) await feed(minute, point, true); };
  /** Drives north, away from Grünheide towards the motorway, one point a minute. */
  const driveOff = async (from: number, points = 10) => { for (let index = 0; index < points; index += 1) await feed(from + index, north(4000 + index * 3000), false); };
  const key = placeKey({ company: 'Tesla Manufacturing Brandenburg SE', address, city: '15537 Grünheide' })!.key;
  return { vehicle, tour, stopId: tour.stops[0].id, tours, places, feed, stand, driveOff, key };
}
const stopOf = (id: string) => db.stop.findUniqueOrThrow({ where: { id } });
const notesOf = (vehicleId: string) => db.notification.findMany({ where: { vehicleId }, orderBy: { createdAt: 'asc' } });

describe('stays of a truck from its GPS', () => {
  const row = (minute: number, point: { latitude: number; longitude: number }, standstill: boolean) =>
    ({ ...point, speedKmh: standstill ? 0 : 60, recordedAt: at(minute), rawJson: JSON.stringify({ standstill }) });

  it('groups standing points into stays, a GPS blip does not split one, driving does', () => {
    const history = [
      ...Array.from({ length: 21 }, (_, minute) => row(minute, GATE, minute !== 10)),
      ...Array.from({ length: 5 }, (_, index) => row(21 + index, north(4000 + index * 2000), false)),
      ...Array.from({ length: 6 }, (_, index) => row(26 + index, north(20_000), true))
    ].reverse();
    const stays = standstillsOf(history);
    expect(stays.map((stay) => [stay.startAt, stay.endAt])).toEqual([[at(0), at(20)], [at(26), at(31)]]);
    expect(distanceMeters(stays[0].latitude, stays[0].longitude, GATE.latitude, GATE.longitude)).toBeLessThan(5);
  });

  it('picks the stay at a gate trucks used before, else the longest, within 5 km and out of the zone', () => {
    const stop = { id: 's', ...ADDRESS_POINT, arrivalRadiusMeters: null, type: 'LOAD', city: 'Grünheide', address: ADDRESS };
    const stay = (minutes: number, point: { latitude: number; longitude: number }, start = 0) =>
      ({ startAt: at(start), endAt: at(start + minutes), seconds: minutes * 60, points: minutes, ...point });
    const around = { radius: 1000, previous: null, next: null, gates: [] as Array<{ latitude: number; longitude: number }> };
    const pause = stay(45, north(-3000));
    const loading = stay(80, GATE, 60);
    expect(pickOffsiteStay([pause, loading], stop, around)).toBe(loading);
    const shortLoading = stay(30, GATE, 60);
    expect(pickOffsiteStay([stay(50, north(-3000)), shortLoading], stop, { ...around, gates: [GATE] })).toBe(shortLoading);
    expect(pickOffsiteStay([stay(15, GATE)], stop, around)).toBeNull();
    expect(pickOffsiteStay([stay(40, north(6000))], stop, around)).toBeNull();
    expect(pickOffsiteStay([stay(40, north(500))], stop, around)).toBeNull();
    // Long before the stop's time it was another trip.
    expect(pickOffsiteStay([stay(40, GATE)], { ...stop, plannedAt: at(0, 1) }, around)).toBeNull();
  });
});

describe('a stay away from the address (owner, 18.11.2026: Tesla)', () => {
  it('records the arrival at the start of the stay and BELADEN at its end once the truck drives on, one note with «Отменить»', async () => {
    const { vehicle, stopId, tour, stand, driveOff, feed, key } = await scenario('OFF-1');
    await stand(0, 30, GATE);
    expect((await stopOf(stopId)).arrivedAt).toBeNull();
    await driveOff(31);
    const stop = await stopOf(stopId);
    expect(stop.arrivedAt).toEqual(at(0));
    expect(stop.completedAt).toEqual(at(30));
    const notes = await notesOf(vehicle.id);
    expect(notes.map((note) => note.type)).toEqual(['AUTO_STOP_EVENT']);
    expect(notes[0].message).toContain('стояла 30 мин в 2 км от адреса');
    expect(notes[0].message).toContain('Прибытие на');
    expect(JSON.parse(notes[0].payloadJson)).toMatchObject({ enteredAt: at(0).toISOString(), at: at(30).toISOString() });
    expect(Math.abs(JSON.parse(notes[0].payloadJson).offsite.distanceMeters - 2000)).toBeLessThan(10);
    expect(await db.auditLog.findFirstOrThrow({ where: { stopId, action: 'ARRIVAL_CONFIRMED' } })).toMatchObject({ actorRole: 'system' });
    expect((await db.event.findFirstOrThrow({ where: { stopId } })).note).toContain('от адреса точки');
    expect((await db.leg.findFirstOrThrow({ where: { tourId: tour.id, fromStopId: stopId } }))).toMatchObject({ status: 'ACTIVE', startedAt: at(30) });
    // The stay is a candidate gate: one stay alone never moves anything.
    const place = await db.knownAddress.findFirstOrThrow({ where: { source: STAY_SOURCE, externalId: stayExternalId(key) } });
    expect(place).toMatchObject({ active: false, useCount: 1 });
    expect(distanceMeters(place.latitude, place.longitude, GATE.latitude, GATE.longitude)).toBeLessThan(5);
    await feed(45, north(40_000), false);
    expect(await db.notification.count({ where: { vehicleId: vehicle.id } })).toBe(1);
  });

  it('does nothing for a short stop, for a stay farther than 5 km, or while the truck is still near', async () => {
    const short = await scenario('OFF-SHORT');
    await short.stand(0, 15, GATE);
    await short.driveOff(16);
    expect((await stopOf(short.stopId)).arrivedAt).toBeNull();

    const far = await scenario('OFF-FAR');
    await far.stand(0, 40, north(6000));
    await far.driveOff(41);
    expect((await stopOf(far.stopId)).arrivedAt).toBeNull();

    const near = await scenario('OFF-NEAR');
    await near.stand(0, 30, GATE);
    await near.feed(31, north(3000), false);
    await near.stand(32, 40, north(3200));
    expect((await stopOf(near.stopId)).arrivedAt).toBeNull();
    expect(await notesOf(near.vehicle.id)).toHaveLength(0);
  });

  it('takes the long unloading and not the 45-minute break before it', async () => {
    const { stopId, stand, driveOff, feed } = await scenario('OFF-PAUSE');
    await stand(0, 45, north(-3000));
    await feed(46, north(0), false);
    await stand(47, 127, GATE);
    await driveOff(128);
    expect(await stopOf(stopId)).toMatchObject({ arrivedAt: at(47), completedAt: at(127) });
  });

  it('leaves it to the ordinary arrival when the truck drove into the zone after the stay', async () => {
    const { stopId, stand, feed } = await scenario('OFF-ZONE');
    await stand(0, 30, GATE);
    await feed(31, north(1200), false);
    await stand(32, 40, north(100));
    const stop = await stopOf(stopId);
    expect(stop.arrivedAt).not.toEqual(at(0));
    expect(stop.completedAt).toBeNull();
  });

  it('unloading and Leergut loading at the same place are both recorded from the one stay, the loading arriving with its event', async () => {
    const { vehicle, tour, stand, driveOff } = await scenario('OFF-CHAIN', { leergut: true });
    await stand(0, 60, GATE);
    await driveOff(61);
    expect(await stopOf(tour.stops[0].id)).toMatchObject({ arrivedAt: at(0), completedAt: at(60) });
    expect(await stopOf(tour.stops[1].id)).toMatchObject({ arrivedAt: at(60), completedAt: at(60) });
    const notes = await notesOf(vehicle.id);
    expect(notes.map((note) => note.type)).toEqual(['AUTO_STOP_EVENT']);
    expect(notes[0].message).toContain('ENTLADEN и BELADEN');
  });

  it('«Отменить» reopens the stop without the arrival, takes the lesson back, and the same stay is not recorded again', async () => {
    const { vehicle, stopId, tours, places, stand, driveOff, feed, key } = await scenario('OFF-UNDO');
    await stand(0, 30, GATE);
    await driveOff(31);
    expect((await stopOf(stopId)).completedAt).toEqual(at(30));
    await tours.revertAutoStopEvent(stopId, at(45), { role: 'dispatcher', sessionId: 's1' });
    expect(await places.forgetVisitOf([stopId], at(45))).toBe(true);
    expect(await places.forgetVisitOf([stopId], at(46))).toBe(false);
    expect(await stopOf(stopId)).toMatchObject({ arrivedAt: null, completedAt: null });
    expect(await db.knownAddress.count({ where: { source: STAY_SOURCE, externalId: stayExternalId(key) } })).toBe(0);
    for (let minute = 46; minute <= 60; minute += 1) await feed(minute, north(50_000 + minute * 1000), false);
    expect((await stopOf(stopId)).completedAt).toBeNull();
    expect(await db.notification.count({ where: { vehicleId: vehicle.id, type: 'AUTO_STOP_EVENT', acknowledgedAt: null } })).toBe(0);
  });
});

describe('a gate learned from two visits moves the stops already planned there', () => {
  async function plannedStop(name: string, extra: { company?: string; address?: string; city?: string; geocodeProvider?: string } = {}) {
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: name, licensePlate: `B-${name}` } });
    const tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
    const tour = await tours.createTour({ vehicleId: vehicle.id, orderNumber: `ORD-${name}`, stops: [
      { sequence: 1, type: 'LOAD', company: extra.company ?? 'Tesla Manufacturing Brandenburg SE', address: extra.address ?? ADDRESS, city: extra.city ?? '15537 Grünheide', ...ADDRESS_POINT },
      { sequence: 2, type: 'UNLOAD', address: 'Hamburg', city: 'Hamburg', ...HAMBURG }
    ] });
    if (extra.geocodeProvider) await db.stop.update({ where: { id: tour.stops[0].id }, data: { geocodeProvider: extra.geocodeProvider } });
    return { vehicle, tour, stopId: tour.stops[0].id };
  }

  it('after the second visit agrees, open stops at that door go to the gate, the route is drawn again, others stay', async () => {
    const rebuild = vi.fn(async () => undefined);
    const gates = new LearnedGates(pg(), rebuild);
    const places = new StayPlaces(pg(), () => undefined, (place, now) => gates.moveOpenStops(place, now));
    const first = await plannedStop('GATE-A');
    const planned = await plannedStop('GATE-B');
    const byRule = await plannedStop('GATE-C', { geocodeProvider: 'address-rule' });
    const other = await plannedStop('GATE-D', { company: 'Zulieferer GmbH', address: 'Industriestraße 4, 15537 Grünheide' });

    await places.learnVisit([first.stopId], GATE, at(0, 1), at(40, 1));
    expect(rebuild).not.toHaveBeenCalled();
    await places.learnVisit([first.stopId], north(2050), at(0, 3), at(40, 3));

    // GATE-A's own stop is open too and is moved like any other planned stop at this door.
    const moved = await stopOf(planned.stopId);
    expect(distanceMeters(moved.latitude, moved.longitude, GATE.latitude, GATE.longitude)).toBeLessThan(60);
    expect(moved).toMatchObject({ geocodeProvider: 'gps-stay', geocodePrecision: 'EXACT' });
    expect(rebuild).toHaveBeenCalledWith(planned.vehicle.id, at(40, 3), expect.objectContaining({ role: 'system' }));
    expect(await stopOf(byRule.stopId)).toMatchObject(ADDRESS_POINT);
    expect(await stopOf(other.stopId)).toMatchObject(ADDRESS_POINT);
    expect(await db.auditLog.count({ where: { stopId: planned.stopId, action: 'STOP_MOVED_TO_LEARNED_GATE' } })).toBe(1);
    const note = await db.notification.findFirstOrThrow({ where: { vehicleId: planned.vehicle.id, type: 'STOP_MOVED_TO_GATE' } });
    expect(note.message).toContain('перенесена на ворота');
    expect(note.message).toContain('2 км от адреса');
  });

  it('a truck whose route cannot be drawn keeps its points', async () => {
    const gates = new LearnedGates(pg(), async () => { throw new Error('Маршрутизатор недоступен'); });
    const stop = await plannedStop('GATE-E', { company: 'Batterie Werk GmbH', address: 'Werkstraße 9, 15537 Grünheide' });
    const key = placeKey({ company: 'Batterie Werk GmbH', address: 'Werkstraße 9, 15537 Grünheide', city: '15537 Grünheide' })!.key;
    expect(await gates.moveOpenStops({ externalId: stayExternalId(key), key, name: 'Batterie Werk GmbH', ...GATE }, at(0, 5))).toEqual([]);
    expect(await stopOf(stop.stopId)).toMatchObject({ ...ADDRESS_POINT, geocodeProvider: null });
    expect(await db.auditLog.count({ where: { action: 'STOP_MOVE_TO_GATE_SKIPPED', vehicleId: stop.vehicle.id } })).toBe(1);
  });
});
