import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-push-schema-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

it('keeps one row per push endpoint, linked to the dispatcher and gone with the account', async () => {
  const anna = await db.dispatcher.create({ data: { login: 'anna', displayName: 'Anna', passwordHash: 'x' } });
  const subscription = await db.pushSubscription.create({ data: { endpoint: 'https://push.example/abc', p256dh: 'p', auth: 'a', dispatcherId: anna.id } });
  expect(subscription).toMatchObject({ failures: 0, lastSentAt: null, workHoursJson: null });
  await expect(db.pushSubscription.create({ data: { endpoint: 'https://push.example/abc', p256dh: 'p', auth: 'a' } })).rejects.toThrow();
  // The shared login has no account: its phone can still subscribe.
  await expect(db.pushSubscription.create({ data: { endpoint: 'https://push.example/shared', p256dh: 'p', auth: 'a' } })).resolves.toBeTruthy();
  expect(await db.dispatcher.findUnique({ where: { id: anna.id }, include: { pushSubscriptions: true } })).toMatchObject({ pushSubscriptions: [{ endpoint: 'https://push.example/abc' }] });
  await db.dispatcher.delete({ where: { id: anna.id } });
  expect(await db.pushSubscription.count()).toBe(1);
});
