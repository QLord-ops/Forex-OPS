import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { findKnownPlace, KnownPlaces, resolveWithoutGeocoder } from '../src/services/known-places.js';
import { placeKey, StayPlaces, stayPoint } from '../src/services/stay-places.js';
import { distanceMeters } from '../src/services/webfleet.js';
import { migrateTestDatabase } from './test-database.js';

// VW Baunatal (owner, 13.11): the postal point of the plant and the truck gate where the trucks really stand, 1.2 km apart.
const POSTAL = { latitude: 51.2585, longitude: 9.4195 };
const GATE = { latitude: 51.2477, longitude: 9.4195 };
const ADDRESS = 'Dr.-Rudolf-Leiding-Platz 1, 34225 Baunatal';
const day = (n: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, n, hour, minute));

let directory: string;
let db: PrismaClient;
const pg = () => db as unknown as PostgresPrismaClient;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-stay-places-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

/** A truck unloading at VW Baunatal on day `n`: it stands at `at` for `minutes`, then ENTLADEN is recorded. */
async function visit(n: number, at: { latitude: number; longitude: number }, minutes = 40, options: { radius?: number; company?: string; jitter?: number; address?: string } = {}) {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: `V-${n}-${Math.random().toString(36).slice(2, 7)}` } });
  const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: `T-${n}`, status: 'ACTIVE' } });
  const arrivedAt = day(n, 8);
  const completedAt = day(n, 8, minutes);
  const stop = await db.stop.create({ data: { tourId: tour.id, sequence: 1, type: 'UNLOAD', company: options.company ?? 'Volkswagen AG Werk Kassel', address: options.address ?? ADDRESS, city: 'Baunatal',
    ...POSTAL, arrivedAt, completedAt, arrivalRadiusMeters: options.radius ?? 2000 } });
  await db.vehicleTelemetry.createMany({ data: Array.from({ length: minutes + 1 }, (_, minute) => {
    const jitter = (options.jitter ?? 0.0002) * Math.sin(minute);
    return { vehicleId: vehicle.id, provider: 'WEBFLEET', externalId: `wf-${stop.id}`, latitude: at.latitude + jitter, longitude: at.longitude - jitter,
      speedKmh: 0, recordedAt: day(n, 8, minute), rawJson: JSON.stringify({ standstill: true }) };
  }) });
  return stop;
}

describe('the point a truck stood at', () => {
  it('is the middle of its standing GPS points in the stop\'s zone; driving points and points far away do not count', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => ({ ...GATE, latitude: GATE.latitude + (i % 2 ? 0.0001 : -0.0001), speedKmh: 0, recordedAt: day(1, 8, i), rawJson: '{"standstill":true}' })),
      { latitude: 51.27, longitude: 9.43, speedKmh: 60, recordedAt: day(1, 8, 21), rawJson: '{"standstill":false}' },
      { latitude: 51.4, longitude: 9.6, speedKmh: 0, recordedAt: day(1, 8, 22), rawJson: '{"standstill":true}' }
    ];
    const point = stayPoint(rows, POSTAL, 2000)!;
    expect(distanceMeters(point.latitude, point.longitude, GATE.latitude, GATE.longitude)).toBeLessThan(20);
    expect(point.points).toBe(20);
  });

  it('needs a real stay: ten standing points over a quarter of an hour', () => {
    const short = Array.from({ length: 8 }, (_, i) => ({ ...GATE, speedKmh: 0, recordedAt: day(1, 8, i), rawJson: '{"standstill":true}' }));
    expect(stayPoint(short, POSTAL, 2000)).toBeNull();
  });

  it('belongs to the door (street with number and postcode), else to the company in its town', () => {
    expect(placeKey({ company: 'VW', address: ADDRESS, city: 'Baunatal' })?.key).toMatch(/^34225\|/);
    expect(placeKey({ company: 'Seifert Logistics', address: 'Bremen', city: 'Bremen' })?.key).toBe('bremen|seifert logistics');
    expect(placeKey({ company: null, address: 'Bremen', city: 'Bremen' })).toBeNull();
  });
});

describe('learning where the trucks stand at a place (owner, 15.11)', () => {
  it('one stay is a candidate; a second that agrees makes it the place, and the next Auftrag takes the gate', async () => {
    const places = new StayPlaces(pg());
    const first = await visit(1, GATE);
    expect(await places.learn(first.id, day(1, 9))).toBe('CANDIDATE');
    const book = new KnownPlaces(pg(), 0);
    expect(findKnownPlace({ address: ADDRESS, city: 'Baunatal', company: 'VW' }, await book.all())?.provider ?? null).not.toBe('gps-stay');

    const second = await visit(3, { latitude: GATE.latitude + 0.0005, longitude: GATE.longitude });
    expect(await places.learn(second.id, day(3, 9))).toBe('LEARNED');
    const found = findKnownPlace({ address: ADDRESS, city: 'Baunatal', company: 'VW' }, await book.all())!;
    expect(found.provider).toBe('gps-stay');
    expect(distanceMeters(found.latitude, found.longitude, GATE.latitude, GATE.longitude)).toBeLessThan(60);
    expect(await db.auditLog.count({ where: { action: 'STAY_PLACE_LEARNED', actorRole: 'system' } })).toBe(1);

    // A stop of a new Auftrag at the same door comes with the gate, before any geocoder is asked.
    const resolved = resolveWithoutGeocoder({ address: ADDRESS, city: 'Baunatal', company: 'Volkswagen AG' }, [], await book.all())!;
    expect(distanceMeters(resolved.latitude, resolved.longitude, GATE.latitude, GATE.longitude)).toBeLessThan(60);
  });

  it('the point of the postal address wins nothing back from a stay somewhere else, once two stays agreed', async () => {
    const places = new StayPlaces(pg());
    const parking = await visit(5, { latitude: GATE.latitude + 0.008, longitude: GATE.longitude });
    expect(await places.learn(parking.id, day(5, 9))).toBe('CONFIRMED');
    const book = new KnownPlaces(pg(), 0);
    const found = findKnownPlace({ address: ADDRESS, city: 'Baunatal', company: 'VW' }, await book.all())!;
    expect(distanceMeters(found.latitude, found.longitude, GATE.latitude, GATE.longitude)).toBeLessThan(60);
  });

  it('the unloading and the Leergut loading of one visit count as one stay, not as two that agree', async () => {
    const places = new StayPlaces(pg());
    const address = 'Industriestraße 5, 38239 Salzgitter';
    const make = async (hour: number) => {
      const vehicle = await db.vehicle.create({ data: { vehicleNumber: `SZ-${hour}` } });
      const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: `SZ-${hour}`, status: 'ACTIVE' } });
      const stop = await db.stop.create({ data: { tourId: tour.id, sequence: 1, type: 'UNLOAD', company: 'MAN', address, city: 'Salzgitter', latitude: 52.16, longitude: 10.41,
        arrivedAt: day(7, hour), completedAt: day(7, hour, 40), arrivalRadiusMeters: 2000 } });
      await db.vehicleTelemetry.createMany({ data: Array.from({ length: 41 }, (_, minute) => ({ vehicleId: vehicle.id, provider: 'WEBFLEET', externalId: `sz-${hour}`,
        latitude: 52.152, longitude: 10.41, speedKmh: 0, recordedAt: day(7, hour, minute), rawJson: '{"standstill":true}' })) });
      return stop;
    };
    expect(await places.learn((await make(8)).id, day(7, 8, 40))).toBe('CANDIDATE');
    expect(await places.learn((await make(9)).id, day(7, 9, 40))).toBe('CANDIDATE');
  });

  it('a stop already at the gate or without a real stay teaches nothing', async () => {
    const places = new StayPlaces(pg());
    const there = await visit(9, POSTAL, 40, { company: 'Lager Nord', address: 'Nordstraße 2, 34225 Baunatal' });
    expect(await places.learn(there.id, day(9, 9))).toBe('ALREADY_THERE');
    const brief = await visit(10, GATE, 8, { company: 'Kurzer Halt', address: 'Südstraße 4, 34225 Baunatal' });
    expect(await places.learn(brief.id, day(10, 9))).toBe('NO_STAY');
  });
});
