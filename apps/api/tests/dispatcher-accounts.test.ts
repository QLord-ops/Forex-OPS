import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { registerDispatcherRoutes } from '../src/routes/dispatchers.js';
import { hashDispatcherPassword, registerDispatcherAuth } from '../src/services/dispatcher-auth.js';
import { migrateTestDatabase } from './test-database.js';

const ORIGIN = 'https://ops.test';
const adminPasswordHash = hashDispatcherPassword('break glass admin');
const dispatcherPasswordHash = hashDispatcherPassword('shared dispatcher');
let directory: string;
let db: PrismaClient;
let now = Date.UTC(2026, 10, 3, 8);

async function server() {
  const app = Fastify();
  registerDispatcherAuth(app, db as never, { adminPasswordHash, dispatcherPasswordHash, secret: 's'.repeat(32), origins: [ORIGIN], now: () => now });
  registerDispatcherRoutes(app, db as unknown as PostgresPrismaClient);
  app.get('/vehicles', async () => []);
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500;
    reply.status(status).send({ error: error instanceof Error ? error.message : 'error' });
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
  directory = await mkdtemp(join(tmpdir(), 'ops-dispatcher-accounts-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('personal dispatcher accounts', () => {
  it('runs the transition: shared passwords until the first account, then personal logins only', async () => {
    const app = await server();
    try {
      // No accounts yet: both shared passwords work.
      expect((await login(app, { password: 'shared dispatcher' })).response.statusCode).toBe(200);
      const admin = await login(app, { password: 'break glass admin' });
      expect(admin.response.json()).toMatchObject({ role: 'admin', dispatcherId: null });

      const created = await app.inject({ method: 'POST', url: '/dispatchers', headers: admin.headers, payload: { login: 'Anna.B', displayName: 'Anna Beispiel', role: 'dispatcher', password: 'anna long password' } });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ login: 'anna.b', displayName: 'Anna Beispiel', role: 'dispatcher', active: true });
      expect(created.body).not.toContain('passwordHash');
      expect((await app.inject({ method: 'POST', url: '/dispatchers', headers: admin.headers, payload: { login: 'kurz', displayName: 'Kurz', role: 'dispatcher', password: 'short' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/dispatchers', headers: admin.headers, payload: { login: 'anna.b', displayName: 'Doppelt', role: 'dispatcher', password: 'another long password' } })).statusCode).toBe(409);

      // The shared dispatcher password stops working once an account exists (after the one-minute cache); the admin one stays.
      now += 61_000;
      expect((await login(app, { password: 'shared dispatcher' })).response.statusCode).toBe(401);
      expect((await login(app, { password: 'break glass admin' })).response.statusCode).toBe(200);

      const anna = await login(app, { login: 'ANNA.B', password: 'anna long password' });
      expect(anna.response.json()).toMatchObject({ role: 'dispatcher', displayName: 'Anna Beispiel', dispatcherId: created.json().id });
      const session = await app.inject({ url: '/auth/session', headers: { cookie: anna.headers.cookie } });
      expect(session.json()).toMatchObject({ authenticated: true, displayName: 'Anna Beispiel' });
      expect((await app.inject({ url: '/dispatchers', headers: anna.headers })).statusCode).toBe(403);
      expect((await app.inject({ url: '/dispatchers/directory', headers: anna.headers })).json()).toEqual([{ id: created.json().id, displayName: 'Anna Beispiel' }]);

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'DISPATCHER_CREATED' } });
      expect(audit).toMatchObject({ actorRole: 'admin', actorDispatcherId: null, entityId: created.json().id });
      expect(audit.metadataJson).not.toContain('password');
    } finally { await app.close(); }
  });

  it('rejects wrong and unknown logins alike and limits guessing per login', async () => {
    const app = await server();
    try {
      const wrong = await login(app, { login: 'anna.b', password: 'not the password' });
      const unknown = await login(app, { login: 'nobody', password: 'not the password' });
      expect(wrong.response.statusCode).toBe(401);
      expect(unknown.response.json()).toEqual(wrong.response.json());
      for (let index = 0; index < 8; index++) await login(app, { login: 'anna.b', password: `wrong ${index}` });
      expect((await login(app, { login: 'anna.b', password: 'anna long password' })).response.statusCode).toBe(429);
    } finally { await app.close(); }
  }, 30_000);

  it('ends the session of a deactivated account and protects the admin from locking themselves out', async () => {
    now += 16 * 60_000; // new rate-limit window
    const app = await server();
    try {
      const breakGlass = await login(app, { password: 'break glass admin' });
      const boss = await app.inject({ method: 'POST', url: '/dispatchers', headers: breakGlass.headers, payload: { login: 'chef', displayName: 'Chef Admin', role: 'admin', password: 'chef long password' } });
      const chef = await login(app, { login: 'chef', password: 'chef long password' });
      expect((await app.inject({ method: 'PATCH', url: `/dispatchers/${boss.json().id}`, headers: chef.headers, payload: { active: false } })).statusCode).toBe(400);

      const anna = await login(app, { login: 'anna.b', password: 'anna long password' });
      expect((await app.inject({ url: '/vehicles', headers: anna.headers })).statusCode).toBe(200);
      const annaId = anna.response.json().dispatcherId;
      expect((await app.inject({ method: 'PATCH', url: `/dispatchers/${annaId}`, headers: chef.headers, payload: { active: false } })).statusCode).toBe(200);
      now += 61_000;
      expect((await app.inject({ url: '/vehicles', headers: anna.headers })).statusCode).toBe(401);
      expect((await login(app, { login: 'anna.b', password: 'anna long password' })).response.statusCode).toBe(401);
      expect(await db.auditLog.count({ where: { action: 'DISPATCHER_DEACTIVATED', actorDispatcherId: boss.json().id } })).toBe(1);
    } finally { await app.close(); }
  });

  it('lets a dispatcher change their own password with the current one', async () => {
    now += 16 * 60_000;
    const app = await server();
    try {
      const admin = await login(app, { password: 'break glass admin' });
      await app.inject({ method: 'POST', url: '/dispatchers', headers: admin.headers, payload: { login: 'ben', displayName: 'Ben Muster', role: 'dispatcher', password: 'ben first password' } });
      const ben = await login(app, { login: 'ben', password: 'ben first password' });
      expect((await app.inject({ method: 'POST', url: '/auth/password', headers: ben.headers, payload: { currentPassword: 'wrong', newPassword: 'ben second password' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/auth/password', headers: ben.headers, payload: { currentPassword: 'ben first password', newPassword: 'ben second password' } })).statusCode).toBe(200);
      expect((await login(app, { login: 'ben', password: 'ben second password' })).response.statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/auth/password', headers: admin.headers, payload: { currentPassword: 'x', newPassword: 'shared cannot change' } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
