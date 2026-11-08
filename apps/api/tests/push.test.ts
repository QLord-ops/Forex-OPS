import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { registerPushRoutes } from '../src/routes/push.js';
import type { DispatcherRole } from '../src/services/dispatcher-auth.js';
import { isWorkTime, PushService, pushPayload, readPushKeys, shouldPush, type PushCandidate } from '../src/services/push.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

const keys = { publicKey: 'BPublicKeyForTests', privateKey: 'private-key-for-tests', subject: 'mailto:dispo@example.com' };
const actor = { role: 'dispatcher' as const, sessionId: 's1', dispatcherId: undefined as string | undefined };
// Monday 10:00 and Monday 22:00 in Berlin (UTC+1 in November).
const monday10 = new Date('2026-11-09T09:00:00Z');
const monday22 = new Date('2026-11-09T21:00:00Z');
const candidate = (id: string, extra: Partial<PushCandidate> = {}): PushCandidate =>
  ({ id, vehicleId: 'v1', type: 'ROUTE_DEVIATION', message: `LKW 997: ${id}`, createdAt: new Date('2026-11-09T08:59:00Z'), priority: 'ACTION', urgent: false, resolved: false, ...extra });

describe('push rules', () => {
  it('reads the keys only from the server environment and is off without them', () => {
    expect(readPushKeys({})).toBeNull();
    expect(readPushKeys({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:a@b.de' })).toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.de' });
  });

  it('pushes every open decision during the working day, only urgent ones at night, never information', () => {
    expect(isWorkTime(monday10)).toBe(true);
    expect(isWorkTime(monday22)).toBe(false);
    expect(isWorkTime(new Date('2026-11-08T09:00:00Z'))).toBe(false); // Sunday
    expect(shouldPush(candidate('a'), true)).toBe(true);
    expect(shouldPush(candidate('a'), false)).toBe(false);
    expect(shouldPush(candidate('a', { urgent: true, type: 'STOP_DEPARTED' }), false)).toBe(true);
    expect(shouldPush(candidate('a', { priority: 'INFO' }), true)).toBe(false);
    expect(shouldPush(candidate('a', { resolved: true, urgent: true }), false)).toBe(false);
  });

  it('builds one slot per truck on the phone and links to the truck', () => {
    expect(pushPayload(candidate('a'))).toEqual({ title: 'Отклонение от маршрута', body: 'LKW 997: a', tag: 'truck-v1', url: '/?vehicleId=v1&card=v1' });
  });
});

describe('push to the dispatchers\' phones', () => {
  let directory: string;
  let db: PrismaClient;
  let sent: Array<{ endpoint: string; payload: { tag: string; title: string } }>;
  let failWith: number | null;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-push-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
    sent = []; failWith = null;
  });
  afterEach(async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); });

  const service = (withKeys = true) => new PushService(asAppDatabase(db), withKeys ? keys : null, async (subscription, payload) => {
    if (failWith) throw Object.assign(new Error('push failed'), { statusCode: failWith });
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
  });
  const everyone = async () => () => true;

  it('stores a phone once per endpoint, audits only the push service host, and forgets it on request', async () => {
    const anna = await db.dispatcher.create({ data: { login: 'anna', displayName: 'Anna', passwordHash: 'x' } });
    const push = service();
    await push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/secret-token', keys: { p256dh: 'p256', auth: 'auth' }, workHours: { days: [1], start: '08:00', end: '16:00' } }, { ...actor, dispatcherId: anna.id });
    await push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/secret-token', keys: { p256dh: 'p256-new', auth: 'auth' } }, { ...actor, dispatcherId: anna.id });
    expect(await db.pushSubscription.findMany()).toEqual([expect.objectContaining({ dispatcherId: anna.id, p256dh: 'p256-new', workHoursJson: null })]);
    const audit = await db.auditLog.findMany({ where: { action: 'PUSH_SUBSCRIBED' } });
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('secret-token');
    expect(await push.unsubscribe('https://fcm.googleapis.com/fcm/send/secret-token', actor)).toEqual({ removed: 1 });
    expect(await db.pushSubscription.count()).toBe(0);
  });

  it('starts from now, then pushes what is new to the phones that may see it, by their working hours', async () => {
    const push = service();
    await db.pushSubscription.create({ data: { endpoint: 'https://push.example/day', p256dh: 'p', auth: 'a', dispatcherId: null } });
    await db.pushSubscription.create({ data: { endpoint: 'https://push.example/other', p256dh: 'p', auth: 'a', dispatcherId: null, workHoursJson: JSON.stringify({ days: [0], start: '08:00', end: '16:00' }) } });
    const old = candidate('old', { createdAt: new Date('2026-11-09T08:00:00Z') });
    expect(await push.sweep(async () => [old], everyone, new Date('2026-11-09T08:30:00Z'))).toEqual({ sent: 0, removed: 0 });

    const fresh = [candidate('deviation'), candidate('left', { type: 'STOP_DEPARTED', urgent: true, vehicleId: 'v2' }), candidate('jam', { priority: 'RISK', vehicleId: 'v3' })];
    const result = await push.sweep(async () => [old, ...fresh], async () => (vehicleId) => vehicleId !== 'v2', monday10);
    // Day phone (default Mon–Sat 06–18): both decisions it may see; the «other» phone only works on Sundays: nothing but urgent.
    expect(result.sent).toBe(1);
    expect(sent.map((item) => [item.endpoint, item.payload.tag])).toEqual([['https://push.example/day', 'truck-v1']]);
    // Nothing new since: nothing is sent twice.
    expect(await push.sweep(async () => [old, ...fresh], everyone, monday10)).toEqual({ sent: 0, removed: 0 });
  });

  it('removes a phone the push service no longer knows and stays off without keys', async () => {
    await db.integrationSyncState.create({ data: { id: 'SYSTEM:PUSH_SWEEP', provider: 'SYSTEM', lastSnapshotAt: new Date('2026-11-09T08:00:00Z') } });
    await db.pushSubscription.create({ data: { endpoint: 'https://push.example/gone', p256dh: 'p', auth: 'a' } });
    expect(await service(false).sweep(async () => [candidate('a')], everyone, monday10)).toEqual({ sent: 0, removed: 0 });
    failWith = 410;
    expect(await service().sweep(async () => [candidate('a')], everyone, monday10)).toEqual({ sent: 0, removed: 1 });
    expect(await db.pushSubscription.count()).toBe(0);
  });

  describe('routes', () => {
    async function build(role: DispatcherRole | null, withKeys = true) {
      const app = Fastify();
      app.addHook('onRequest', async (request) => {
        request.dispatcherSession = role ? { token: 't', expiresAt: Number.MAX_SAFE_INTEGER, role, sessionId: 's', dispatcherId: null, displayName: 'Test' } : null;
      });
      // As in app.ts: invalid input is a 400, not a server error.
      app.setErrorHandler((error, _request, reply) => reply.status(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as Error).message }));
      registerPushRoutes(app, service(withKeys));
      return app;
    }
    const body = { endpoint: 'https://push.example/phone', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA', auth: 'tBHItJI5svbpez7KI4CCXg' } };

    it('gives the public key, subscribes and unsubscribes a signed-in dispatcher\'s phone', async () => {
      const app = await build('dispatcher');
      expect((await app.inject({ method: 'GET', url: '/push/config' })).json()).toEqual({ enabled: true, publicKey: keys.publicKey });
      expect((await app.inject({ method: 'POST', url: '/push/subscribe', payload: body })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/push/subscribe', payload: { ...body, endpoint: 'http://push.example/phone' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/push/unsubscribe', payload: { endpoint: body.endpoint } })).json()).toEqual({ removed: 1 });
    });

    it('refuses anonymous callers and says when the server has no keys', async () => {
      expect((await (await build(null)).inject({ method: 'GET', url: '/push/config' })).statusCode).toBe(401);
      const unconfigured = await build('dispatcher', false);
      expect((await unconfigured.inject({ method: 'GET', url: '/push/config' })).json()).toEqual({ enabled: false, publicKey: null });
      expect((await unconfigured.inject({ method: 'POST', url: '/push/subscribe', payload: body })).statusCode).toBe(503);
    });
  });
});
