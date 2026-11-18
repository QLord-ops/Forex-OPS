import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { mergeProfile, parseProfile } from '../src/services/customer-profile.js';
import { CUSTOMER_NOTICE_EVENT, CustomerNotices, customerNoticeInput } from '../src/services/customer-notice.js';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { migrateTestDatabase } from './test-database.js';

let directory: string;
let db: PrismaClient;
const notices = () => new CustomerNotices(db as unknown as PostgresPrismaClient);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-customer-notice-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
});
afterEach(async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); });

async function tour(number = '187') {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: number } });
  const created = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: `FX-${number}`, status: 'ACTIVE', stops: { create: [
    { sequence: 1, type: 'LOAD', address: 'Bovenden', city: 'Bovenden', latitude: 51.58, longitude: 9.92, completedAt: new Date('2026-11-18T08:40:00Z') },
    { sequence: 2, type: 'UNLOAD', address: 'Jena', city: 'Jena', latitude: 50.92, longitude: 11.58 }
  ] } }, include: { stops: { orderBy: { sequence: 'asc' } } } });
  return { vehicle, tour: created, done: created.stops[0], open: created.stops[1] };
}

describe('«Сообщить заказчику» (owner, 18.11.2026)', () => {
  it('keeps the recipients in the customer profile, lower case and checked', () => {
    expect(parseProfile('{}').notify).toEqual({ emails: [] });
    const merged = mergeProfile(parseProfile('{}'), { notify: { emails: [' Dispo@Musterwerk.de ', 'leitstand@musterwerk.de'] } });
    expect(merged.notify.emails).toEqual(['dispo@musterwerk.de', 'leitstand@musterwerk.de']);
    expect(() => mergeProfile(parseProfile('{}'), { notify: { emails: ['not an address'] } })).toThrow();
    expect(() => mergeProfile(parseProfile('{}'), { notify: { emails: Array.from({ length: 11 }, (_, index) => `a${index}@x.de`) } })).toThrow();
  });

  it('records who told the customer, when and with which ETA, and the dashboard reads the latest per tour', async () => {
    const { vehicle, tour: active, open } = await tour();
    const dispatcher = await db.dispatcher.create({ data: { login: 'anna', displayName: 'Anna Demo', passwordHash: 'x' } });
    const first = await notices().record(vehicle.id, { tourId: active.id, stopId: open.id, channel: 'EMAIL', etaAt: '2026-11-18T14:05:00.000Z', delayMinutes: 40, recipients: 2 },
      { role: 'dispatcher', sessionId: 's1', dispatcherId: dispatcher.id }, new Date('2026-11-18T12:45:00Z'));
    expect(first).toEqual({ at: '2026-11-18T12:45:00.000Z', by: 'Anna Demo', channel: 'EMAIL', stopId: open.id, etaAt: '2026-11-18T14:05:00.000Z', delayMinutes: 40 });
    await notices().record(vehicle.id, { tourId: active.id, stopId: open.id, channel: 'COPY', recipients: 0 }, { role: 'admin', sessionId: 's2' }, new Date('2026-11-18T13:10:00Z'));

    const latest = await notices().latestByTour([active.id, 'other']);
    expect(latest.get(active.id)).toMatchObject({ at: '2026-11-18T13:10:00.000Z', by: 'администратор', channel: 'COPY', etaAt: null });
    expect(latest.has('other')).toBe(false);
    expect(await db.operationEvent.count({ where: { type: CUSTOMER_NOTICE_EVENT, tourId: active.id } })).toBe(2);
  });

  it('refuses a stop of another tour, a finished stop and a tour of another truck', async () => {
    const { vehicle, tour: active, done } = await tour('187');
    const other = await tour('214');
    const input = (stopId: string, tourId = active.id) => ({ tourId, stopId, channel: 'EMAIL' as const, recipients: 1 });
    await expect(notices().record(vehicle.id, input(other.open.id), undefined)).rejects.toMatchObject({ statusCode: 404 });
    await expect(notices().record(vehicle.id, input(done.id), undefined)).rejects.toMatchObject({ statusCode: 409 });
    await expect(notices().record(vehicle.id, input(other.open.id, other.tour.id), undefined)).rejects.toMatchObject({ statusCode: 404 });
    expect(await db.operationEvent.count()).toBe(0);
  });

  it('validates the input strictly: no letter text, no addresses, only the channel and counts', () => {
    expect(customerNoticeInput.safeParse({ tourId: 't', stopId: 's', channel: 'EMAIL', recipients: 1 }).success).toBe(true);
    expect(customerNoticeInput.safeParse({ tourId: 't', stopId: 's', channel: 'SMS', recipients: 1 }).success).toBe(false);
    expect(customerNoticeInput.safeParse({ tourId: 't', stopId: 's', channel: 'EMAIL', recipients: 1, body: 'Guten Tag' }).success).toBe(false);
    expect(customerNoticeInput.safeParse({ tourId: 't', stopId: 's', channel: 'EMAIL', recipients: 21 }).success).toBe(false);
    expect(customerNoticeInput.safeParse({ tourId: 't', stopId: 's', channel: 'EMAIL', recipients: 1, etaAt: 'soon' }).success).toBe(false);
  });
});

describe('POST /vehicles/:id/customer-notice', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterAll(async () => { await Promise.all(apps.map((app) => app.close())); });

  it('needs a dispatcher session and validates the body before touching data', async () => {
    const secured = await buildApp({ auth: { origins: ['http://localhost:5173'], dispatcherPasswordHash: 'scrypt:' + '0'.repeat(32) + ':' + '0'.repeat(128), secret: 's'.repeat(40) } });
    apps.push(secured);
    const payload = { tourId: 't1', stopId: 's1', channel: 'EMAIL', recipients: 1 };
    expect((await secured.inject({ method: 'POST', url: '/vehicles/v1/customer-notice', headers: { origin: 'http://localhost:5173' }, payload })).statusCode).toBe(401);
    const open = await buildApp({ auth: { disabled: true } });
    apps.push(open);
    expect((await open.inject({ method: 'POST', url: '/vehicles/v1/customer-notice', payload: { ...payload, channel: 'FAX' } })).statusCode).toBe(400);
  });
});
