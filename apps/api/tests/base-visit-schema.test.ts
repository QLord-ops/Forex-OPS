import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-base-visit-schema-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

it('keeps one base week per truck and week, and the weeks before it as history', async () => {
  const truck = await db.vehicle.create({ data: { vehicleNumber: '125' } });
  const week = { weekStart: new Date('2026-11-16T00:00:00.000Z'), dueAt: new Date('2026-11-20T17:00:00.000Z'), freeAt: new Date('2026-11-23T05:00:00.000Z') };
  const visit = await db.baseVisit.create({ data: { vehicleId: truck.id, ...week } });
  expect(visit).toMatchObject({ arrivedAt: null, arrivedSource: null, arrivedByDispatcherId: null, cancelledAt: null, cancelledByDispatcherId: null, createdByDispatcherId: null });
  await expect(db.baseVisit.create({ data: { vehicleId: truck.id, ...week } })).rejects.toThrow();
  // Two weeks later the same truck is on the list again: a new row, the old one stays.
  await db.baseVisit.create({ data: { vehicleId: truck.id, weekStart: new Date('2026-11-30T00:00:00.000Z'), dueAt: new Date('2026-12-04T17:00:00.000Z'), freeAt: new Date('2026-12-07T05:00:00.000Z') } });
  expect(await db.vehicle.findUnique({ where: { id: truck.id }, include: { baseVisits: true } })).toMatchObject({ baseVisits: [{}, {}] });
  await expect(db.baseVisit.create({ data: { vehicleId: 'missing', ...week } })).rejects.toThrow();
  await db.vehicle.delete({ where: { id: truck.id } });
  expect(await db.baseVisit.count()).toBe(0);
});

it('keeps one row per setting', async () => {
  await db.appSetting.create({ data: { key: 'BASE', valueJson: '{"address":"Musterweg 1, 37154 Northeim"}' } });
  await expect(db.appSetting.create({ data: { key: 'BASE', valueJson: '{}' } })).rejects.toThrow();
  expect(await db.appSetting.update({ where: { key: 'BASE' }, data: { valueJson: '{}', updatedByDispatcherId: 'admin' } })).toMatchObject({ valueJson: '{}', updatedByDispatcherId: 'admin' });
});
