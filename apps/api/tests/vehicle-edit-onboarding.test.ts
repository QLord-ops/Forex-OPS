import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { registerDispatcherRoutes } from '../src/routes/dispatchers.js';
import { hashDispatcherPassword, registerDispatcherAuth } from '../src/services/dispatcher-auth.js';
import { VehicleService } from '../src/services/vehicles.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

const ORIGIN = 'https://ops.test';
let directory: string;
let db: PrismaClient;
let now = Date.UTC(2026, 10, 6, 8);

async function server() {
  const app = Fastify();
  registerDispatcherAuth(app, db as never, { adminPasswordHash: hashDispatcherPassword('break glass admin'), dispatcherPasswordHash: hashDispatcherPassword('shared dispatcher'), secret: 's'.repeat(32), origins: [ORIGIN], now: () => now });
  registerDispatcherRoutes(app, db as unknown as PostgresPrismaClient);
  app.setErrorHandler((error, _request, reply) => {
    reply.status(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error instanceof Error ? error.message : 'error' });
  });
  await app.ready();
  return app;
}

async function login(app: FastifyInstance, body: Record<string, string>) {
  const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: ORIGIN }, payload: body });
  const cookie = String(response.headers['set-cookie'] ?? '').split(';')[0];
  return { response, headers: { origin: ORIGIN, cookie, 'x-csrf-token': response.json().csrfToken ?? '' } };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-vehicle-edit-onboarding-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

it('edits number, plate and speed of a truck and refuses a number another truck has', async () => {
  const service = new VehicleService(asAppDatabase(db));
  const first = await service.create({ vehicleNumber: '321', licensePlate: 'GÖ-FX 321', maxSpeedKmh: 85 });
  await service.create({ vehicleNumber: '997', maxSpeedKmh: 85 });
  const result = await service.update(first.id, { vehicleNumber: '321', licensePlate: 'GÖ-FX 3210', maxSpeedKmh: 80 });
  expect(result.vehicle).toMatchObject({ vehicleNumber: '321', licensePlate: 'GÖ-FX 3210', maxSpeedKmh: 80 });
  expect(result.before).toEqual({ licensePlate: 'GÖ-FX 321', maxSpeedKmh: 85 });
  expect(result.after).toEqual({ licensePlate: 'GÖ-FX 3210', maxSpeedKmh: 80 });
  expect((await service.update(first.id, { licensePlate: '' })).vehicle.licensePlate).toBeNull();
  await expect(service.update(first.id, { vehicleNumber: '997' })).rejects.toMatchObject({ statusCode: 409 });
  expect((await service.update(first.id, {})).before).toEqual({});
});

it('tells the web whether the dispatcher went through the tour and records when they finish it', async () => {
  const app = await server();
  try {
    const admin = await login(app, { password: 'break glass admin' });
    // A shared login has no account to remember the tour in: the browser keeps it.
    expect((await app.inject({ method: 'POST', url: '/auth/onboarding', headers: admin.headers, payload: { completed: true } })).json()).toEqual({ ok: true, stored: false });
    const created = await app.inject({ method: 'POST', url: '/dispatchers', headers: admin.headers, payload: { login: 'neu', displayName: 'Neu Beispiel', role: 'dispatcher', password: 'neu long password' } });
    expect(created.json()).toMatchObject({ onboardingCompletedAt: null });
    const neu = await login(app, { login: 'neu', password: 'neu long password' });
    expect(neu.response.json()).toMatchObject({ dispatcherId: created.json().id, onboardingCompletedAt: null });

    const done = await app.inject({ method: 'POST', url: '/auth/onboarding', headers: neu.headers, payload: { completed: true } });
    expect(done.json()).toMatchObject({ ok: true, stored: true });
    expect(typeof done.json().onboardingCompletedAt).toBe('string');
    // The account is cached for a minute; after that the session carries the mark.
    now += 61_000;
    const session = await app.inject({ url: '/auth/session', headers: { cookie: neu.headers.cookie } });
    expect(session.json().onboardingCompletedAt).toBe(done.json().onboardingCompletedAt);
    expect((await app.inject({ url: '/dispatchers', headers: admin.headers })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ login: 'neu', onboardingCompletedAt: done.json().onboardingCompletedAt })]));
    expect((await app.inject({ method: 'POST', url: '/auth/onboarding', headers: neu.headers, payload: { completed: 'yes' } })).statusCode).toBe(400);
    expect(await db.auditLog.count({ where: { action: 'ONBOARDING_COMPLETED', actorDispatcherId: created.json().id } })).toBe(1);
  } finally { await app.close(); }
});
