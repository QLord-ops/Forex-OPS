import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { registerVehicleAssignmentRoutes } from '../src/routes/vehicle-assignment.js';
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
const assign = (headers: Record<string, string>, vehicleId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/vehicles/${vehicleId}/assignment`, headers, payload });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-assignment-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
  for (const [login, role] of [['anna', 'dispatcher'], ['ben', 'dispatcher'], ['chef', 'admin'], ['gone', 'dispatcher']] as const) {
    ids[login] = (await db.dispatcher.create({ data: { login, displayName: login.toUpperCase(), role, passwordHash: hashDispatcherPassword(`${login} long password`), active: login !== 'gone' } })).id;
  }
  ids.truck = (await db.vehicle.create({ data: { vehicleNumber: '2803' } })).id;
  app = Fastify();
  registerDispatcherAuth(app, db as never, { secret: 's'.repeat(32), origins: [ORIGIN] });
  registerVehicleAssignmentRoutes(app, db as unknown as PostgresPrismaClient);
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

it('lets one dispatcher take a free truck; the second click gets 409', async () => {
  const [anna, ben] = await Promise.all([signIn('anna'), signIn('ben')]);
  const results = await Promise.all([
    assign(anna, ids.truck, { action: 'take', expectedDispatcherId: null }),
    assign(ben, ids.truck, { action: 'take', expectedDispatcherId: null })
  ]);
  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
  const winner = results.find((result) => result.statusCode === 200)!.json().assignedTo.id;
  expect([ids.anna, ids.ben]).toContain(winner);
  // Leave the truck with Anna for the next steps.
  if (winner === ids.ben) await assign(ben, ids.truck, { action: 'handover', toDispatcherId: ids.anna, expectedDispatcherId: ids.ben });
  expect((await db.vehicle.findUniqueOrThrow({ where: { id: ids.truck } })).assignedDispatcherId).toBe(ids.anna);
});

it('allows only the owner to hand over or release, and only to active colleagues', async () => {
  const [anna, ben] = await Promise.all([signIn('anna'), signIn('ben')]);
  expect((await assign(ben, ids.truck, { action: 'take', expectedDispatcherId: ids.anna })).statusCode).toBe(403);
  expect((await assign(ben, ids.truck, { action: 'release', expectedDispatcherId: ids.anna })).statusCode).toBe(403);
  expect((await assign(anna, ids.truck, { action: 'handover', toDispatcherId: ids.gone, expectedDispatcherId: ids.anna })).statusCode).toBe(400);
  const handed = await assign(anna, ids.truck, { action: 'handover', toDispatcherId: ids.ben, expectedDispatcherId: ids.anna });
  expect(handed.json()).toMatchObject({ assignedTo: { id: ids.ben, name: 'BEN' } });
  expect((await assign(ben, ids.truck, { action: 'release', expectedDispatcherId: ids.ben })).json()).toMatchObject({ assignedTo: null });
});

it('lets only an admin reassign someone else\'s truck and audits every change with the person', async () => {
  const [anna, chef] = await Promise.all([signIn('anna'), signIn('chef')]);
  await assign(anna, ids.truck, { action: 'take', expectedDispatcherId: null });
  expect((await assign(anna, ids.truck, { action: 'reassign', toDispatcherId: ids.anna, expectedDispatcherId: ids.anna })).statusCode).toBe(403);
  expect((await assign(chef, ids.truck, { action: 'reassign', toDispatcherId: ids.chef, expectedDispatcherId: ids.anna })).json()).toMatchObject({ assignedTo: { id: ids.chef } });
  const entries = await db.auditLog.findMany({ where: { action: 'VEHICLE_ASSIGNMENT_CHANGED' }, orderBy: { createdAt: 'asc' } });
  expect(entries.at(-1)).toMatchObject({ actorDispatcherId: ids.chef, vehicleId: ids.truck });
  expect(JSON.parse(entries.at(-1)!.metadataJson!)).toEqual({ action: 'reassign', from: ids.anna, to: ids.chef });
});
