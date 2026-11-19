import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-driver-shift-schema-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

it('keeps shift codes per truck, without a person, and removes them with the truck', async () => {
  const truck = await db.vehicle.create({ data: { vehicleNumber: '214' } });
  const endsAt = new Date('2026-11-19T18:00:00.000Z');
  const shift = await db.driverShift.create({ data: { vehicleId: truck.id, codeHash: 'scrypt:salt:hash', endsAt } });
  expect(shift).toMatchObject({ failedAttempts: 0, firstUsedAt: null, lastUsedAt: null, endedAt: null, endedByDispatcherId: null, createdByDispatcherId: null });
  expect(Object.keys(shift).sort()).toEqual(['codeHash', 'createdAt', 'createdByDispatcherId', 'endedAt', 'endedByDispatcherId', 'endsAt',
    'failedAttempts', 'firstUsedAt', 'id', 'lastUsedAt', 'startsAt', 'vehicleId']);
  // A new code for the same truck does not replace the old row: the history of shifts stays.
  await db.driverShift.create({ data: { vehicleId: truck.id, codeHash: 'scrypt:salt:other', endsAt } });
  expect(await db.vehicle.findUnique({ where: { id: truck.id }, include: { driverShifts: true } })).toMatchObject({ driverShifts: [{}, {}] });
  await expect(db.driverShift.create({ data: { vehicleId: 'missing', codeHash: 'x', endsAt } })).rejects.toThrow();
  await db.vehicle.delete({ where: { id: truck.id } });
  expect(await db.driverShift.count()).toBe(0);
});

it('stores who recorded a stop event and leaves older events without a source', async () => {
  const truck = await db.vehicle.create({ data: { vehicleNumber: '215' } });
  const tour = await db.tour.create({ data: { vehicleId: truck.id, orderNumber: 'A-1' } });
  const stop = await db.stop.create({ data: { tourId: tour.id, sequence: 1, type: 'UNLOAD', address: 'Industriestraße Nord 1, 38239 Salzgitter', latitude: 52.15, longitude: 10.4 } });
  const base = { vehicleId: truck.id, tourId: tour.id, stopId: stop.id, type: 'UNLOADED', timestamp: new Date('2026-11-19T10:42:00.000Z') };
  expect(await db.event.create({ data: base })).toMatchObject({ source: null });
  expect(await db.event.create({ data: { ...base, source: 'DRIVER' } })).toMatchObject({ source: 'DRIVER' });
});
