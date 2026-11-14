import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { pooledDatabaseUrl } from '../src/lib/prisma.js';
import { registerVehicleAssignmentRoutes } from '../src/routes/vehicle-assignment.js';
import { hashDispatcherPassword, registerDispatcherAuth } from '../src/services/dispatcher-auth.js';
import { ImportSlots } from '../src/services/import-jobs.js';
import { migrateTestDatabase } from './test-database.js';

const ORIGIN = 'https://ops.test';
const TEAM = ['anna', 'ben', 'clara', 'dmitri', 'elena'] as const;
let directory: string;
let db: PrismaClient;
let app: FastifyInstance;
const ids: Record<string, string> = {};

async function signIn(login: string) {
  const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: ORIGIN }, payload: { login, password: `${login} long password` } });
  expect(response.statusCode).toBe(200);
  return { origin: ORIGIN, cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken as string };
}
const take = (headers: Record<string, string>, vehicleId: string) =>
  app.inject({ method: 'POST', url: `/vehicles/${vehicleId}/assignment`, headers, payload: { action: 'take', expectedDispatcherId: null } });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-five-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
  for (const login of TEAM) {
    ids[login] = (await db.dispatcher.create({ data: { login, displayName: login.toUpperCase(), role: 'dispatcher', passwordHash: hashDispatcherPassword(`${login} long password`), active: true } })).id;
    ids[`truck-${login}`] = (await db.vehicle.create({ data: { vehicleNumber: `LKW-${login}` } })).id;
  }
  ids.shared = (await db.vehicle.create({ data: { vehicleNumber: 'LKW-shared' } })).id;
  app = Fastify();
  registerDispatcherAuth(app, db as never, { secret: 's'.repeat(32), origins: [ORIGIN] });
  // The same limit and key as the real app: a session, not the office's shared address.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', keyGenerator: (request) => request.dispatcherSession?.sessionId ?? request.ip });
  registerVehicleAssignmentRoutes(app, db as unknown as PostgresPrismaClient);
  app.get('/ping', async (request) => ({ who: request.dispatcherSession?.dispatcherId }));
  app.setErrorHandler((error, _request, reply) => {
    reply.status(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error instanceof Error ? error.message : 'error' });
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('five dispatchers working at the same time', () => {
  it('signs all five in at once from one office address, each into their own account', async () => {
    const sessions = await Promise.all(TEAM.map((login) => signIn(login)));
    const answers = await Promise.all(sessions.map((headers) => app.inject({ method: 'GET', url: '/ping', headers })));
    expect(answers.map((answer) => answer.json().who)).toEqual(TEAM.map((login) => ids[login]));
    expect(new Set(sessions.map((session) => session.cookie)).size).toBe(5);
  });

  it('one dispatcher who uses up the request limit does not slow the other four', async () => {
    const sessions = await Promise.all(TEAM.map((login) => signIn(login)));
    const busy = await Promise.all(Array.from({ length: 320 }, () => app.inject({ method: 'GET', url: '/ping', headers: sessions[0] })));
    expect(busy.filter((answer) => answer.statusCode === 429).length).toBeGreaterThan(0);
    const others = await Promise.all(sessions.slice(1).flatMap((headers) => Array.from({ length: 60 }, () => app.inject({ method: 'GET', url: '/ping', headers }))));
    expect(others.every((answer) => answer.statusCode === 200)).toBe(true);
  });

  it('each takes a truck of their own line at the same moment; a truck all five want goes to exactly one', async () => {
    const sessions = await Promise.all(TEAM.map((login) => signIn(login)));
    const own = await Promise.all(TEAM.map((login, index) => take(sessions[index], ids[`truck-${login}`])));
    expect(own.map((answer) => answer.statusCode)).toEqual([200, 200, 200, 200, 200]);
    for (const login of TEAM) {
      expect((await db.vehicle.findUniqueOrThrow({ where: { id: ids[`truck-${login}`] } })).assignedDispatcherId).toBe(ids[login]);
    }
    const race = await Promise.all(sessions.map((headers) => take(headers, ids.shared)));
    expect(race.map((answer) => answer.statusCode).sort()).toEqual([200, 409, 409, 409, 409]);
  });

  it('one dispatcher signing out leaves the other four at work', async () => {
    const sessions = await Promise.all(TEAM.map((login) => signIn(login)));
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: sessions[0] })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ping', headers: sessions[0] })).statusCode).toBe(401);
    const rest = await Promise.all(sessions.slice(1).map((headers) => app.inject({ method: 'GET', url: '/ping', headers })));
    expect(rest.map((answer) => answer.statusCode)).toEqual([200, 200, 200, 200]);
  });
});

describe('five Auftrag uploaded in the same minute', () => {
  it('reads two at a time and lets the other three wait their turn instead of refusing them', async () => {
    const slots = new ImportSlots(2, 8);
    const order: string[] = [];
    let running = 0, most = 0;
    const read = async (name: string) => {
      const slot = slots.enter();
      expect(slot).not.toBeNull();
      await slot!.ready;
      running += 1; most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(name);
      running -= 1;
      slot!.leave();
    };
    const all = Promise.all(TEAM.map((login) => read(login)));
    expect(slots.active).toBe(2);
    expect(slots.queued).toBe(3);
    await all;
    expect(most).toBe(2);
    expect(order).toEqual([...TEAM]);
    expect(slots.active).toBe(0);
  });

  it('refuses only when the line itself is full, and a place given up while waiting goes to the next one', async () => {
    const slots = new ImportSlots(1, 2);
    const first = slots.enter()!, second = slots.enter()!, third = slots.enter()!;
    expect(slots.enter()).toBeNull();
    let thirdStarted = false;
    void third.ready.then(() => { thirdStarted = true; });
    second.leave();
    second.leave();
    expect(slots.queued).toBe(1);
    first.leave();
    await third.ready;
    expect(thirdStarted).toBe(true);
    expect(slots.active).toBe(1);
    third.leave();
    expect(slots.active).toBe(0);
  });
});

describe('database connections for five open screens', () => {
  it('asks for a pool of eight instead of the three Prisma takes on a one-CPU server, and keeps an explicit choice', () => {
    expect(pooledDatabaseUrl('postgresql://user@db.example:25060/ops?sslmode=require', undefined)).toBe('postgresql://user@db.example:25060/ops?sslmode=require&connection_limit=8&pool_timeout=20');
    expect(pooledDatabaseUrl('postgres://user@db.example/ops', '12')).toBe('postgres://user@db.example/ops?connection_limit=12&pool_timeout=20');
    expect(pooledDatabaseUrl('postgres://user@db.example/ops', '500')).toContain('connection_limit=20');
    expect(pooledDatabaseUrl('postgres://user@db.example/ops?connection_limit=5', undefined)).toBeUndefined();
    expect(pooledDatabaseUrl('file:./dev.db', undefined)).toBeUndefined();
    expect(pooledDatabaseUrl(undefined, undefined)).toBeUndefined();
  });
});
