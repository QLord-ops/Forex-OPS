import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-dispatcher-schema-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('stores personal accounts, truck owners and the person behind an audited action', async () => {
  const dispatcher = await db.dispatcher.create({ data: { login: 'anna', displayName: 'Anna Beispiel', passwordHash: 'scrypt$x' } });
  expect(dispatcher).toMatchObject({ role: 'dispatcher', active: true, lastLoginAt: null });
  await expect(db.dispatcher.create({ data: { login: 'anna', displayName: 'Doppelt', passwordHash: 'scrypt$y' } })).rejects.toThrow();

  const free = await db.vehicle.create({ data: { vehicleNumber: 'free-1' } });
  expect(free.assignedDispatcherId).toBeNull();
  const mine = await db.vehicle.create({ data: { vehicleNumber: 'mine-1', assignedDispatcherId: dispatcher.id, assignedAt: new Date() } });
  expect(await db.vehicle.findMany({ where: { assignedDispatcherId: dispatcher.id } })).toEqual([expect.objectContaining({ id: mine.id })]);

  const entry = await db.auditLog.create({ data: { actorRole: 'dispatcher', actorSessionId: 's1', actorDispatcherId: dispatcher.id, action: 'VEHICLE_TAKEN', entityType: 'Vehicle', entityId: mine.id } });
  expect(entry.actorDispatcherId).toBe(dispatcher.id);
});
