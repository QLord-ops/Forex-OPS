import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-pending-appointment-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('keeps a recognised appointment until it is attached, and refuses the same document twice', async () => {
  const pending = await db.pendingAppointment.create({ data: {
    documentKind: 'VW_FAHRTENSCHEIN', fingerprint: 'termin-test-1', vehiclePlate: 'GOFX900', company: 'Werk Beispiel', city: 'Wolfsburg',
    stopType: 'UNLOAD', appointmentAt: new Date('2026-11-04T08:30:00Z'), referencesJson: JSON.stringify(['T0000000001'])
  } });
  expect(pending).toMatchObject({ status: 'PENDING', attachedStopId: null, windowStartAt: null });
  await expect(db.pendingAppointment.create({ data: { documentKind: 'OTHER', fingerprint: 'termin-test-1' } })).rejects.toThrow();
  const attached = await db.pendingAppointment.update({ where: { id: pending.id }, data: { status: 'ATTACHED', attachedStopId: 'stop-1' } });
  expect(attached.status).toBe('ATTACHED');
});
