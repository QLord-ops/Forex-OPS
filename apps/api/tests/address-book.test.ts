import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { registerAddressBookRoutes } from '../src/routes/address-book.js';
import { AddressBookSync, parseWebfleetAddress, searchAddresses } from '../src/services/address-book.js';
import { hashDispatcherPassword, registerDispatcherAuth } from '../src/services/dispatcher-auth.js';
import { WebfleetError, type WebfleetConfig } from '../src/services/webfleet.js';
import { migrateTestDatabase } from './test-database.js';

const ORIGIN = 'https://ops.test';
const config: WebfleetConfig = { account: 'a', apiKey: 'k', username: 'u', password: 'p', baseUrl: 'https://csv.webfleet.com/extern' } as WebfleetConfig;
let directory: string;
let db: PrismaClient;
const now = new Date('2026-11-06T08:00:00Z');
const row = (uid: string, name: string, extra: Record<string, unknown> = {}) => ({ addruid: uid, addrnr: uid.toUpperCase(), addrname1: name, addrstreet: 'Frisiusstraße 1', addrzip: '26723',
  addrcity: 'Emden', addrstate: 'DE', positiony: 53366000, positionx: 7206000, radius: 400, ...extra });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-address-book-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
beforeEach(async () => { await db.knownAddress.deleteMany(); await db.integrationSyncState.deleteMany(); await db.addressRule.deleteMany(); });

const sync = (request: (config: WebfleetConfig, action: string, params?: Record<string, string>) => Promise<unknown[]>) =>
  new AddressBookSync(db as unknown as PostgresPrismaClient, config, request as never);

describe('Webfleet address rows', () => {
  it('reads micro-degree coordinates and skips rows without a position', () => {
    expect(parseWebfleetAddress(row('u1', 'VW Werk Emden'))).toMatchObject({ externalId: 'u1', externalNumber: 'U1', name: 'VW Werk Emden', postalCode: '26723', city: 'Emden', country: 'DE', latitude: 53.366, longitude: 7.206, radiusMeters: 400 });
    expect(parseWebfleetAddress({ addruid: 'u2', addrname1: 'Ohne Position' })).toBeNull();
    expect(parseWebfleetAddress(row('u3', 'Null', { positiony: 0, positionx: 0 }))).toBeNull();
    // Webfleet leaves empty fields out: the name falls back to street and city.
    expect(parseWebfleetAddress({ addruid: 'u4', addrstreet: 'Hafenstr. 2', addrcity: 'Bremen', positiony: 53080000, positionx: 8800000 })).toMatchObject({ name: 'Hafenstr. 2, Bremen', radiusMeters: null });
  });
});

describe('address book sync', () => {
  it('asks Webfleet only for address columns, adds, updates and hides by addruid, and audits the counts', async () => {
    const request = vi.fn(async (_config: WebfleetConfig, action: string, _params?: Record<string, string>) => action === 'showAddressReportExtern'
      ? [row('u1', 'VW Werk Emden'), row('u2', 'BLG Bremerhaven', { addrcity: 'Bremerhaven' })]
      : [{ addruid: 'u1', addressgroupname: 'Kunden VW' }]);
    const first = await sync(request).refreshIfDue(now, now.getTime());
    expect(first).toMatchObject({ error: null, total: 2, added: 2, updated: 0, hidden: 0 });
    expect(request.mock.calls[0]![2]!.columnfilter).not.toMatch(/contact|tel|mail|addrinfo/);
    expect(await db.knownAddress.findFirstOrThrow({ where: { externalId: 'u1' } })).toMatchObject({ groups: 'Kunden VW', searchText: expect.stringContaining('kunden vw') });

    // Not due again for 6 hours.
    expect(await sync(request).refreshIfDue(new Date(now.getTime() + 60 * 60_000), now.getTime() + 60 * 60_000)).toBeNull();
    const later = new Date(now.getTime() + 6 * 3600_000 + 1000);
    request.mockImplementation(async (_config, action) => action === 'showAddressReportExtern' ? [row('u1', 'VW Werk Emden Tor 17')] : []);
    expect(await sync(request).refreshIfDue(later, later.getTime())).toMatchObject({ total: 1, added: 0, updated: 1, hidden: 1 });
    expect(await db.knownAddress.findFirstOrThrow({ where: { externalId: 'u2' } })).toMatchObject({ active: false });
    expect(await db.auditLog.count({ where: { action: 'ADDRESS_BOOK_SYNCED', actorRole: 'system' } })).toBe(2);
  });
  it('waits for a fresh position snapshot and pauses 30 minutes when the user may not read addresses', async () => {
    const request = vi.fn(async () => { throw new WebfleetError('PERMISSION', 45); });
    expect(await sync(request).refreshIfDue(now, now.getTime() - 10 * 60_000)).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(await sync(request).refreshIfDue(now, now.getTime())).toMatchObject({ error: 'PERMISSION', providerCode: 45, nextAt: new Date(now.getTime() + 30 * 60_000).toISOString() });
    expect(await sync(request).refreshIfDue(new Date(now.getTime() + 10 * 60_000), now.getTime() + 10 * 60_000)).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('address search', () => {
  it('finds Webfleet addresses by every word, umlauts folded, then learned sites; the most used first', async () => {
    await sync(async (_c, action) => action === 'showAddressReportExtern' ? [row('u1', 'VW Werk Emden'), row('u2', 'Emder Hafen Süd', { addrcity: 'Emden' }), row('u3', 'Müller Logistik', { addrcity: 'Göttingen', addrzip: '37083' })] : []).refreshIfDue(now, now.getTime());
    await db.knownAddress.updateMany({ where: { externalId: 'u2' }, data: { useCount: 5 } });
    await db.addressRule.create({ data: { pattern: 'seifert bremen', kind: 'SITE', company: 'Seifert Logistics', city: 'Bremen', street: 'Am Hafen 1', latitude: 53.1, longitude: 8.8 } });
    expect((await searchAddresses(db as unknown as PostgresPrismaClient, 'emd')).map((item) => item.label)).toEqual(['Emder Hafen Süd', 'VW Werk Emden']);
    expect((await searchAddresses(db as unknown as PostgresPrismaClient, 'vw emden'))[0]).toMatchObject({ source: 'WEBFLEET', label: 'VW Werk Emden', line2: 'Frisiusstraße 1, 26723 Emden', latitude: 53.366, radiusMeters: 400 });
    expect((await searchAddresses(db as unknown as PostgresPrismaClient, 'MULLER göttingen'))[0]!.label).toBe('Müller Logistik');
    expect((await searchAddresses(db as unknown as PostgresPrismaClient, 'seifert'))[0]).toMatchObject({ source: 'RULE', label: 'Seifert Logistics', city: 'Bremen' });
    expect(await searchAddresses(db as unknown as PostgresPrismaClient, 'e')).toEqual([]);
  });
});

describe('routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    for (const [login, role] of [['anna', 'dispatcher'], ['chef', 'admin']] as const) {
      await db.dispatcher.create({ data: { login, displayName: login, role, passwordHash: hashDispatcherPassword(`${login} long password`) } });
    }
    app = Fastify();
    registerDispatcherAuth(app, db as never, { secret: 's'.repeat(32), origins: [ORIGIN] });
    registerAddressBookRoutes(app, db as unknown as PostgresPrismaClient, sync(async (_c, action) => action === 'showAddressReportExtern' ? [row('u1', 'VW Werk Emden')] : []));
    app.setErrorHandler((error, _request, reply) => {
      reply.status(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error instanceof Error ? error.message : 'error' });
    });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });
  const signIn = async (login: string) => {
    const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: ORIGIN }, payload: { login, password: `${login} long password` } });
    return { origin: ORIGIN, cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken };
  };

  it('search needs a session; only an admin refreshes from Webfleet, and the refresh is audited', async () => {
    expect((await app.inject({ method: 'GET', url: '/addresses/search?q=vw' })).statusCode).toBe(401);
    const [anna, chef] = await Promise.all([signIn('anna'), signIn('chef')]);
    expect((await app.inject({ method: 'POST', url: '/integrations/webfleet/address-book/sync', headers: anna })).statusCode).toBe(403);
    const synced = await app.inject({ method: 'POST', url: '/integrations/webfleet/address-book/sync', headers: chef });
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toMatchObject({ configured: true, total: 1, error: null });
    expect(await db.auditLog.count({ where: { action: 'ADDRESS_BOOK_SYNCED', actorRole: 'admin' } })).toBe(1);
    const found = (await app.inject({ method: 'GET', url: '/addresses/search?q=werk', headers: anna })).json() as { suggestions: Array<{ id: string }> };
    expect(found.suggestions).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: `/addresses/${found.suggestions[0]!.id}/used`, headers: anna })).statusCode).toBe(200);
    expect((await db.knownAddress.findFirstOrThrow()).useCount).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/addresses/search?q=' + 'x'.repeat(200), headers: anna })).statusCode).toBe(400);
  });
});
