import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { registerDriverShiftRoutes } from '../src/routes/driver-shifts.js';
import { hashDispatcherPassword, registerDispatcherAuth, type DispatcherAuthOptions } from '../src/services/dispatcher-auth.js';
import { driverOrigins, normalizeVehicleInput, registerDriverAuth, SHIFT_CODE_ATTEMPTS } from '../src/services/driver-auth.js';
import { migrateTestDatabase } from './test-database.js';

const OFFICE = 'https://ops.test';
const CAB = 'https://fahrer.test';
const adminPasswordHash = hashDispatcherPassword('break glass admin');
const secret = 's'.repeat(32);
let directory: string;
let db: PrismaClient;
let truckId: string;
let now = Date.UTC(2026, 10, 19, 6);

async function server(withDriverApp = true) {
  const app = Fastify();
  const prisma = db as unknown as PostgresPrismaClient;
  let driverGate: NonNullable<DispatcherAuthOptions['driverGate']> | undefined;
  registerDispatcherAuth(app, db as never, { adminPasswordHash, secret, origins: [OFFICE], now: () => now,
    ...(withDriverApp ? { driverGate: (request, reply) => driverGate!(request, reply) } : {}) });
  if (withDriverApp) driverGate = registerDriverAuth(app, prisma, { secret, origins: [CAB], now: () => now });
  registerDriverShiftRoutes(app, prisma, () => new Date(now));
  app.get('/vehicles', async () => []);
  app.get('/driver/tour', async request => ({ vehicleId: request.driverSession?.vehicleId ?? null }));
  app.post('/driver/ping', async () => ({ ok: true }));
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500;
    reply.status(status).send({ error: error instanceof Error ? error.message : 'error' });
  });
  await app.ready();
  return app;
}

async function dispatcher(app: FastifyInstance) {
  const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: OFFICE }, payload: { password: 'break glass admin' } });
  return { origin: OFFICE, cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken as string };
}

async function issue(app: FastifyInstance, payload: Record<string, unknown> = {}) {
  const response = await app.inject({ method: 'POST', url: `/vehicles/${truckId}/driver-shift`, headers: await dispatcher(app), payload });
  expect(response.statusCode).toBe(201);
  return response.json() as { code: string; shift: { id: string; endsAt: string; locked: boolean } };
}

async function signIn(app: FastifyInstance, vehicle: string, code: string) {
  const response = await app.inject({ method: 'POST', url: '/driver/auth/login', headers: { origin: CAB }, payload: { vehicle, code } });
  const cookie = String(response.headers['set-cookie'] ?? '').split(';')[0];
  return { response, headers: { origin: CAB, cookie, 'x-csrf-token': response.statusCode === 200 ? response.json().csrfToken as string : '' } };
}

const wrong = (code: string) => code === '000000' ? '000001' : '000000';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-driver-auth-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
  truckId = (await db.vehicle.create({ data: { vehicleNumber: '214', licensePlate: 'GÖ-FX 214' } })).id;
  await db.vehicle.create({ data: { vehicleNumber: '936', licensePlate: 'KS-OP 936' } });
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

// Wrong-code counters are kept per 15 minutes: every test starts in a fresh window.
beforeEach(() => { now += 60 * 60_000; });

describe('driver app sign-in with a shift code', () => {
  it('opens the driver app only on the sites named for it; production names none by default', () => {
    expect(driverOrigins(undefined, false)).toEqual(['http://localhost:5174', 'http://127.0.0.1:5174']);
    expect(driverOrigins(undefined, true)).toEqual([]);
    expect(driverOrigins(' https://ops-fahrer.vercel.app , https://fahrer.forex.de ', true)).toEqual(['https://ops-fahrer.vercel.app', 'https://fahrer.forex.de']);
  });

  it('reads the truck the way a driver types it', () => {
    expect(normalizeVehicleInput('gö-fx 214')).toBe('GÖFX214');
    expect(normalizeVehicleInput(' GÖ FX214 ')).toBe(normalizeVehicleInput('GÖ-FX 214'));
  });

  it('issues a code once, stores only its hash and signs the truck in', async () => {
    const app = await server();
    try {
      const issued = await issue(app);
      expect(issued.code).toMatch(/^\d{6}$/);
      expect(new Date(issued.shift.endsAt).getTime()).toBe(now + 15 * 3_600_000);
      const stored = await db.driverShift.findUniqueOrThrow({ where: { id: issued.shift.id } });
      expect(stored.codeHash).toMatch(/^scrypt:/);
      expect(stored.codeHash).not.toContain(issued.code);
      const state = await app.inject({ url: `/vehicles/${truckId}/driver-shift`, headers: await dispatcher(app) });
      expect(state.json()).toEqual({ shift: expect.objectContaining({ id: issued.shift.id, firstUsedAt: null, locked: false }) });
      expect(JSON.stringify(state.json())).not.toContain(issued.code);

      const driver = await signIn(app, 'gö-fx 214', issued.code);
      expect(driver.response.statusCode).toBe(200);
      expect(driver.response.json()).toMatchObject({ authenticated: true, expiresAt: issued.shift.endsAt, vehicle: { vehicleNumber: '214', licensePlate: 'GÖ-FX 214' } });
      expect(String(driver.response.headers['set-cookie'])).toMatch(/^ops_driver=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=54000$/);
      expect((await app.inject({ url: '/driver/tour', headers: driver.headers })).json()).toEqual({ vehicleId: truckId });
      expect((await app.inject({ url: '/driver/auth/session', headers: driver.headers })).json()).toMatchObject({ authenticated: true, vehicle: { vehicleNumber: '214' } });
      // The fleet number works as well as the plate.
      expect((await signIn(app, '214', issued.code)).response.statusCode).toBe(200);

      const audit = await db.auditLog.findMany({ where: { vehicleId: truckId }, orderBy: { createdAt: 'asc' } });
      expect(audit.map(row => `${row.actorRole}:${row.action}`)).toEqual(['admin:DRIVER_SHIFT_ISSUED', 'driver:DRIVER_LOGIN', 'driver:DRIVER_LOGIN']);
      expect(audit.every(row => !`${row.metadataJson}`.includes(issued.code))).toBe(true);
      expect(await db.driverShift.findUniqueOrThrow({ where: { id: issued.shift.id } })).toMatchObject({ failedAttempts: 0, firstUsedAt: new Date(now), lastUsedAt: new Date(now) });
    } finally { await app.close(); }
  });

  it('keeps the two doors apart: a driver session opens only /driver, a dispatcher session never does', async () => {
    const app = await server();
    try {
      const office = await dispatcher(app);
      const driver = await signIn(app, 'GÖ-FX 214', (await issue(app)).code);
      expect((await app.inject({ url: '/vehicles', headers: driver.headers })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: `/vehicles/${truckId}/driver-shift`, headers: driver.headers, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ url: '/driver/tour', headers: office })).statusCode).toBe(401);
      expect((await app.inject({ url: '/driver/tour' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/driver/ping', headers: office })).statusCode).toBe(403);
      // A change needs the driver app's own site and its CSRF token.
      expect((await app.inject({ method: 'POST', url: '/driver/ping', headers: { ...driver.headers, origin: OFFICE } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/driver/ping', headers: { ...driver.headers, 'x-csrf-token': 'x' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/driver/ping', headers: driver.headers })).json()).toEqual({ ok: true });
      // A dispatcher cookie forged into the driver cookie's name is not a driver session.
      expect((await app.inject({ url: '/driver/tour', headers: { cookie: office.cookie.replace('ops_dispatcher=', 'ops_driver=') } })).statusCode).toBe(401);
    } finally { await app.close(); }
    const closed = await server(false);
    try {
      expect((await closed.inject({ url: '/driver/tour' })).statusCode).toBe(404);
      expect((await closed.inject({ method: 'POST', url: '/driver/auth/login', headers: { origin: CAB }, payload: { vehicle: '214', code: '123456' } })).statusCode).toBe(404);
    } finally { await closed.close(); }
  });

  it('answers a wrong code and an unknown truck the same way, and locks the code after five wrong tries', async () => {
    const app = await server();
    try {
      const issued = await issue(app);
      const unknownTruck = await signIn(app, 'XX-YY 1', issued.code);
      const noShift = await signIn(app, 'KS-OP 936', issued.code);
      const badFormat = await signIn(app, '214', '12345');
      for (const attempt of [unknownTruck, noShift, badFormat]) {
        expect(attempt.response.statusCode).toBe(401);
        expect(attempt.response.json()).toEqual({ error: 'Неверный номер машины или код.' });
      }
      expect((await db.driverShift.findUniqueOrThrow({ where: { id: issued.shift.id } })).failedAttempts).toBe(0);

      for (let attempt = 1; attempt <= SHIFT_CODE_ATTEMPTS; attempt++) {
        expect((await signIn(app, '214', wrong(issued.code))).response.statusCode).toBe(401);
      }
      const locked = await signIn(app, '214', issued.code);
      expect(locked.response.statusCode).toBe(423);
      expect(locked.response.json().error).toContain('Новый код — у диспетчера');
      expect(await db.auditLog.count({ where: { action: 'DRIVER_SHIFT_LOCKED', entityId: issued.shift.id, actorRole: 'system' } })).toBe(1);
      expect((await app.inject({ url: `/vehicles/${truckId}/driver-shift`, headers: await dispatcher(app) })).json()).toMatchObject({ shift: { locked: true } });

      // The dispatcher's new code works; a correct sign-in clears earlier slips.
      now += 60 * 60_000;
      const fresh = await issue(app);
      expect((await signIn(app, '214', wrong(fresh.code))).response.statusCode).toBe(401);
      expect((await signIn(app, '214', fresh.code)).response.statusCode).toBe(200);
      expect((await db.driverShift.findUniqueOrThrow({ where: { id: fresh.shift.id } })).failedAttempts).toBe(0);
    } finally { await app.close(); }
  });

  it('stops guessing from one address after ten wrong codes in 15 minutes', async () => {
    const app = await server();
    try {
      const issued = await issue(app);
      for (let attempt = 1; attempt <= 10; attempt++) expect((await signIn(app, 'XX-YY 1', '123456')).response.statusCode).toBe(401);
      const blocked = await signIn(app, '214', issued.code);
      expect(blocked.response.statusCode).toBe(429);
      expect(Number(blocked.response.headers['retry-after'])).toBeGreaterThan(0);
      now += 15 * 60_000;
      expect((await signIn(app, '214', issued.code)).response.statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('signs the phone out when the shift ends, a new code is issued, the dispatcher ends it, or the driver logs out', async () => {
    const app = await server();
    try {
      const first = await issue(app, { hours: 2 });
      const old = await signIn(app, '214', first.code);
      expect((await app.inject({ url: '/driver/tour', headers: old.headers })).statusCode).toBe(200);

      const second = await issue(app, { hours: 2 });
      expect((await app.inject({ url: '/driver/tour', headers: old.headers })).statusCode).toBe(401);
      expect((await signIn(app, '214', first.code)).response.statusCode).toBe(401);
      expect(await db.driverShift.findUniqueOrThrow({ where: { id: first.shift.id } })).toMatchObject({ endedAt: new Date(now) });

      const current = await signIn(app, '214', second.code);
      const loggedOut = await app.inject({ method: 'POST', url: '/driver/auth/logout', headers: current.headers });
      expect(loggedOut.json()).toEqual({ authenticated: false });
      expect((await app.inject({ url: '/driver/tour', headers: current.headers })).statusCode).toBe(401);
      // Logging out does not end the shift: the same code signs in again.
      const again = await signIn(app, '214', second.code);
      expect(again.response.statusCode).toBe(200);

      const ended = await app.inject({ method: 'DELETE', url: `/vehicles/${truckId}/driver-shift`, headers: await dispatcher(app) });
      expect(ended.json()).toEqual({ ended: true });
      expect((await app.inject({ url: '/driver/tour', headers: again.headers })).statusCode).toBe(401);
      expect((await app.inject({ url: '/driver/auth/session', headers: again.headers })).json()).toEqual({ authenticated: false });
      expect((await signIn(app, '214', second.code)).response.statusCode).toBe(401);
      expect((await app.inject({ method: 'DELETE', url: `/vehicles/${truckId}/driver-shift`, headers: await dispatcher(app) })).json()).toEqual({ ended: false });

      const third = await issue(app, { hours: 1 });
      const short = await signIn(app, '214', third.code);
      now += 60 * 60_000;
      expect((await app.inject({ url: '/driver/tour', headers: short.headers })).statusCode).toBe(401);
      expect((await signIn(app, '214', third.code)).response.statusCode).toBe(401);
      expect((await app.inject({ url: `/vehicles/${truckId}/driver-shift`, headers: await dispatcher(app) })).json()).toEqual({ shift: null });
    } finally { await app.close(); }
  });

  it('accepts a shift of 1 hour to 7 days only', async () => {
    const app = await server();
    try {
      const headers = await dispatcher(app);
      for (const hours of [0, 169, 1.5]) {
        expect((await app.inject({ method: 'POST', url: `/vehicles/${truckId}/driver-shift`, headers, payload: { hours } })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: 'POST', url: `/vehicles/${truckId}/driver-shift`, headers, payload: { hours: 168 } })).statusCode).toBe(201);
    } finally { await app.close(); }
  });
});
