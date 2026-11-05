import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-address-book-schema-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

it('keeps one saved address per source and external id, active and unused by default', async () => {
  const address = await db.knownAddress.create({ data: { source: 'WEBFLEET', externalId: 'uid-1', name: 'VW Werk Emden', latitude: 53.36, longitude: 7.2, searchText: 'vw werk emden' } });
  expect(address).toMatchObject({ active: true, useCount: 0, radiusMeters: null, groups: null });
  await expect(db.knownAddress.create({ data: { source: 'WEBFLEET', externalId: 'uid-1', name: 'Doppelt', latitude: 1, longitude: 1, searchText: 'doppelt' } })).rejects.toThrow();
  await expect(db.knownAddress.create({ data: { source: 'OPS', externalId: 'uid-1', name: 'Eigene', latitude: 1, longitude: 1, searchText: 'eigene' } })).resolves.toBeTruthy();
});
