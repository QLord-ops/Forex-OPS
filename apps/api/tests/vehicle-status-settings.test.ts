import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { registerVehicleStatusSettingsRoutes } from '../src/routes/vehicle-status-settings.js';
import { hashDispatcherPassword, registerDispatcherAuth } from '../src/services/dispatcher-auth.js';
import { migrateTestDatabase } from './test-database.js';

const ORIGIN = 'https://ops.test';
let directory: string;
let db: PrismaClient;
let app: FastifyInstance;
const ids: Record<string, string> = {};

async function signIn(login: string) {
  const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: ORIGIN }, payload: { login, password: `${login} long password` } });
  return { origin: ORIGIN, cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-status-settings-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
  for (const [login, role] of [['anna', 'dispatcher'], ['chef', 'admin']] as const) {
    ids[login] = (await db.dispatcher.create({ data: { login, displayName: login, role, passwordHash: hashDispatcherPassword(`${login} long password`) } })).id;
  }
  for (const number of ['9724', '727', '2853', '321', '5555']) {
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: number } });
    ids[number] = vehicle.id;
    // 5555 has no Webfleet: it is not offered.
    if (number !== '5555') await db.vehicleIntegration.create({ data: { vehicleId: vehicle.id, provider: 'WEBFLEET', externalId: `obj-${number}` } });
  }
  await db.vehicle.update({ where: { id: ids['321'] }, data: { line: 'WALTER_TESLA' } });
  app = Fastify();
  registerDispatcherAuth(app, db as never, { secret: 's'.repeat(32), origins: [ORIGIN] });
  registerVehicleStatusSettingsRoutes(app, db as unknown as PostgresPrismaClient);
  app.setErrorHandler((error, _request, reply) => {
    reply.status(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error instanceof Error ? error.message : 'error' });
  });
  await app.ready();
}, 20_000);

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('a dispatcher sets the group, flags and the truck phone; the phone never reaches the audit log', async () => {
  const anna = await signIn('anna');
  const response = await app.inject({ method: 'PATCH', url: `/vehicles/${ids['9724']}/status-settings`, headers: anna,
    payload: { statusGroup: 'NORD', servicePhone: '+49 1556 7813051', aSchild: false, appSped: true } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ vehicleNumber: '9724', statusGroup: 'NORD', servicePhone: '+49 1556 7813051', appSped: true });
  const entry = await db.auditLog.findFirstOrThrow({ where: { action: 'VEHICLE_STATUS_SETTINGS_UPDATED', vehicleId: ids['9724'] } });
  expect(entry.actorDispatcherId).toBe(ids.anna);
  expect(entry.metadataJson).toContain('servicePhoneChanged');
  expect(entry.metadataJson).not.toContain('7813051');
  // Operation version untouched: settings never conflict with trip actions.
  expect((await db.vehicle.findUniqueOrThrow({ where: { id: ids['9724'] } })).operationVersion).toBe(0);
});

it('rejects unknown fields, a bad phone, an empty change and an unknown truck', async () => {
  const anna = await signIn('anna');
  const patch = (id: string, payload: unknown) => app.inject({ method: 'PATCH', url: `/vehicles/${id}/status-settings`, headers: anna, payload: payload as Record<string, unknown> });
  expect((await patch(ids['9724'], { line: 'SCHNELLECKE', driverName: 'x' })).statusCode).toBe(400);
  expect((await patch(ids['9724'], { servicePhone: 'call me' })).statusCode).toBe(400);
  expect((await patch(ids['9724'], { statusGroup: 'WEST' })).statusCode).toBe(400);
  expect((await patch(ids['9724'], {})).statusCode).toBe(400);
  expect((await patch('missing', { aSchild: true })).statusCode).toBe(404);
});

it('only an admin sees and applies the Schnellecke preset: 727, 2853 and trucks with a line stay unchecked', async () => {
  const [anna, chef] = await Promise.all([signIn('anna'), signIn('chef')]);
  expect((await app.inject({ method: 'GET', url: '/vehicles/status-settings/preset', headers: anna })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/vehicles/status-settings/bulk', headers: anna, payload: { line: 'SCHNELLECKE', vehicleIds: [ids['9724']] } })).statusCode).toBe(403);

  const preset = (await app.inject({ method: 'GET', url: '/vehicles/status-settings/preset', headers: chef })).json() as { candidates: Array<{ vehicleNumber: string; defaultSelected: boolean; currentLine: string | null }> };
  expect(preset.candidates.map((item) => item.vehicleNumber).sort()).toEqual(['2853', '321', '727', '9724']);
  expect(Object.fromEntries(preset.candidates.map((item) => [item.vehicleNumber, item.defaultSelected]))).toEqual({ '9724': true, '727': false, '2853': false, '321': false });

  const all = [ids['9724'], ids['321']];
  const applied = await app.inject({ method: 'POST', url: '/vehicles/status-settings/bulk', headers: chef, payload: { line: 'SCHNELLECKE', vehicleIds: all } });
  expect(applied.json()).toEqual({ changed: 1, skipped: 1 });
  expect((await db.vehicle.findUniqueOrThrow({ where: { id: ids['321'] } })).line).toBe('WALTER_TESLA');
  expect((await db.vehicle.findUniqueOrThrow({ where: { id: ids['9724'] } })).line).toBe('SCHNELLECKE');
  const entry = await db.auditLog.findFirstOrThrow({ where: { action: 'VEHICLE_LINE_BULK_SET' } });
  expect(JSON.parse(entry.metadataJson!)).toMatchObject({ line: 'SCHNELLECKE', vehicles: ['9724'], skipped: 1 });
});
