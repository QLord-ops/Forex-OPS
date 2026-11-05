import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-daily-status-schema-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const row = (reportId: string, vehicleId: string | null, sortIndex = 0) => ({ reportId, vehicleId, vehicleNumber: '9724', sortIndex, rule: 'EN_ROUTE', startKind: 'NONE', ankunftKind: 'NONE' });

it('a truck starts without a line, group or flags', async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'schema-1' } });
  expect(vehicle).toMatchObject({ line: null, statusGroup: null, servicePhone: null, aSchild: false, appSped: false });
});

it('keeps one list per line and day and one row per truck in it', async () => {
  const report = await db.dailyStatusReport.create({ data: { line: 'SCHNELLECKE', date: '2026-11-05', generatedByRole: 'system' } });
  expect(report).toMatchObject({ status: 'GENERATING', preliminary: false, generatedAt: null });
  await expect(db.dailyStatusReport.create({ data: { line: 'SCHNELLECKE', date: '2026-11-05', generatedByRole: 'system' } })).rejects.toThrow();
  await expect(db.dailyStatusReport.create({ data: { line: 'WALTER_TESLA', date: '2026-11-05', generatedByRole: 'system' } })).resolves.toBeTruthy();

  const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'schema-2' } });
  await db.dailyStatusRow.create({ data: row(report.id, vehicle.id) });
  await expect(db.dailyStatusRow.create({ data: row(report.id, vehicle.id, 1) })).rejects.toThrow();
});

it('a past list survives a deleted truck and goes away with its report', async () => {
  const report = await db.dailyStatusReport.create({ data: { line: 'SCHNELLECKE', date: '2026-11-04', generatedByRole: 'system' } });
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'schema-3' } });
  const created = await db.dailyStatusRow.create({ data: row(report.id, vehicle.id) });
  await db.vehicle.delete({ where: { id: vehicle.id } });
  expect(await db.dailyStatusRow.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ vehicleId: null, vehicleNumber: '9724' });
  await db.dailyStatusReport.delete({ where: { id: report.id } });
  expect(await db.dailyStatusRow.count({ where: { reportId: report.id } })).toBe(0);
});
