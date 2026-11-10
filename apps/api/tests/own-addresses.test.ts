import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { addressSearchText, searchAddresses } from '../src/services/address-book.js';
import { findKnownPlace, KnownPlaces } from '../src/services/known-places.js';
import { OwnAddressBook, ownAddressOf } from '../src/services/own-addresses.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { TourService } from '../src/services/tours.js';
import { createInitialClockState } from '../src/services/vehicle-clock.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

const exact = { geocodePrecision: 'EXACT' as const, geocodeProvider: 'nominatim' };
const stop = (extra: Record<string, unknown>) => ({ company: 'Volkswagen AG Werk Salzgitter', address: 'Industriestraße Nord 1, 38239 Salzgitter', city: 'Salzgitter', latitude: 52.19, longitude: 10.4,
  geocodePrecision: 'EXACT', geocodeProvider: 'nominatim', ...extra }) as Parameters<typeof ownAddressOf>[0];

describe('which stop is an address worth remembering', () => {
  it('takes a named company at a door with a point on the map', () => {
    expect(ownAddressOf(stop({}))).toMatchObject({ name: 'Volkswagen AG Werk Salzgitter', street: 'Industriestraße Nord 1', postalCode: '38239', city: 'Salzgitter', latitude: 52.19, longitude: 10.4 });
    // A picked suggestion or a learned place is trusted whatever precision the stop carries.
    expect(ownAddressOf(stop({ geocodePrecision: null, geocodeProvider: 'address-rule' }))).not.toBeNull();
    expect(ownAddressOf(stop({ city: null }))).toMatchObject({ city: 'Salzgitter' });
  });

  it('leaves out anything less than the door itself', () => {
    expect(ownAddressOf(stop({ geocodePrecision: 'STREET' }))).toBeNull();
    expect(ownAddressOf(stop({ geocodePrecision: 'CITY' }))).toBeNull();
    expect(ownAddressOf(stop({ geocodePrecision: null }))).toBeNull();
    expect(ownAddressOf(stop({ geocodeProvider: 'openai-web+nominatim' }))).toBeNull();
    expect(ownAddressOf(stop({ company: null }))).toBeNull();
    expect(ownAddressOf(stop({ address: 'Salzgitter' }))).toBeNull();
    expect(ownAddressOf(stop({ address: 'Industriestraße Nord 1, Salzgitter' }))).toBeNull();
    expect(ownAddressOf(stop({ address: 'Industriestraße Nord, 38239 Salzgitter' }))).toBeNull();
    expect(ownAddressOf(stop({ latitude: 0, longitude: 0 }))).toBeNull();
  });

  it('never remembers the own yard under a customer name', () => {
    expect(ownAddressOf(stop({ company: 'Volkswagen Original Teile Logistik', address: 'Büttenstraße 4, 37120 Bovenden', city: 'Bovenden' }))).toBeNull();
    expect(ownAddressOf(stop({ company: 'Forex Group GmbH', address: 'Büttenstr. 4, 37120 Bovenden', city: 'Bovenden' }))).not.toBeNull();
  });
});

describe('the own address book', () => {
  let db: PrismaClient;
  let directory: string;
  let counter = 0;
  const actor = { role: 'dispatcher' as const, sessionId: 's', dispatcherId: 'd1' };
  const zwickau = { type: 'LOAD' as const, company: 'Lieferant Zwickau', address: 'Reichenbacher Straße 80, 08056 Zwickau', city: 'Zwickau', latitude: 50.72, longitude: 12.49, ...exact };
  const plant = { type: 'UNLOAD' as const, company: 'Volkswagen AG Werk Salzgitter', address: 'Industriestraße Nord 1, 38239 Salzgitter', city: 'Salzgitter', latitude: 52.19, longitude: 10.4, ...exact };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-own-addresses-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
  }, 20_000);
  afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

  async function tour(stops: Array<Record<string, unknown>>) {
    counter += 1;
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: `OA${counter}`, licensePlate: `GÖ-OA ${counter}`, clockState: JSON.stringify(createInitialClockState({ effectiveAt: new Date('2026-11-03T04:00:00Z') })) } });
    const tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
    return tours.createTour({ vehicleId: vehicle.id, orderNumber: `OA-${counter}`, stops: stops.map((item, index) => ({ sequence: index + 1, ...item })) } as Parameters<TourService['createTour']>[0]);
  }

  it('remembers the exact addresses of a saved tour, suggests them and counts them the next time', async () => {
    const changed = vi.fn();
    const book = new OwnAddressBook(asAppDatabase(db), changed);
    const first = await tour([zwickau, plant]);
    expect(await book.rememberTour(first.id, actor)).toEqual({ added: 2, counted: 0, skipped: 0 });
    expect(changed).toHaveBeenCalledTimes(1);

    const rows = await db.knownAddress.findMany({ where: { source: 'OPS' }, orderBy: { name: 'asc' } });
    expect(rows.map((row) => [row.name, row.street, row.postalCode, row.city, row.useCount, row.active])).toEqual([
      ['Lieferant Zwickau', 'Reichenbacher Straße 80', '08056', 'Zwickau', 1, true],
      ['Volkswagen AG Werk Salzgitter', 'Industriestraße Nord 1', '38239', 'Salzgitter', 1, true]
    ]);
    expect(rows[1].externalId).toMatch(/^ops:[0-9a-f]{24}$/);
    expect(await db.auditLog.count({ where: { action: 'KNOWN_ADDRESS_LEARNED' } })).toBe(2);

    const found = await searchAddresses(asAppDatabase(db), 'volkswagen salz');
    expect(found).toEqual([expect.objectContaining({ source: 'OPS', label: 'Volkswagen AG Werk Salzgitter', line2: 'Industriestraße Nord 1, 38239 Salzgitter', latitude: 52.19, longitude: 10.4 })]);
    // The reading of the next Auftrag gets the place with its coordinates.
    const place = findKnownPlace({ address: 'Industriestr. Nord 1, 38239 Salzgitter', company: 'VW' }, await new KnownPlaces(asAppDatabase(db)).all());
    expect(place).toMatchObject({ latitude: 52.19, provider: 'ops-address' });

    const second = await tour([zwickau, plant]);
    expect(await book.rememberTour(second.id, actor)).toEqual({ added: 0, counted: 2, skipped: 0 });
    expect((await db.knownAddress.findMany({ where: { source: 'OPS' } })).map((row) => row.useCount)).toEqual([2, 2]);
    expect(await db.auditLog.count({ where: { action: 'KNOWN_ADDRESS_LEARNED' } })).toBe(2);
    expect(await book.rememberTour('no-such-tour', actor)).toEqual({ added: 0, counted: 0, skipped: 0 });
  });

  it('skips what is not exact and only counts a door Webfleet already has', async () => {
    const book = new OwnAddressBook(asAppDatabase(db));
    const webfleet = { name: 'TST Süderelbe', name2: null, street: 'Dradenauer Deichweg 3', postalCode: '21129', city: 'Hamburg' };
    const row = await db.knownAddress.create({ data: { ...webfleet, source: 'WEBFLEET', externalId: 'wf-1', latitude: 53.5, longitude: 9.9, searchText: addressSearchText(webfleet) } });
    const created = await tour([
      { type: 'LOAD', company: 'TST', address: 'Dradenauer Deichweg 3, 21129 Hamburg', city: 'Hamburg', latitude: 53.5, longitude: 9.9, ...exact },
      { type: 'UNLOAD', company: 'Seifert', address: 'Bremen', city: 'Bremen', latitude: 53.07, longitude: 8.8, geocodePrecision: 'CITY', geocodeProvider: 'nominatim' },
      { type: 'UNLOAD', company: 'Handtmann', address: 'Arno-Schmidt-Str. 5, 09487 Königswalde', city: 'Königswalde', latitude: 50.5, longitude: 13.0, geocodePrecision: 'EXACT', geocodeProvider: 'openai-web+nominatim' }
    ]);
    expect(await book.rememberTour(created.id, actor)).toEqual({ added: 0, counted: 1, skipped: 2 });
    expect((await db.knownAddress.findUniqueOrThrow({ where: { id: row.id } })).useCount).toBe(1);
    expect(await db.knownAddress.count({ where: { source: 'OPS', city: 'Hamburg' } })).toBe(0);
  });

  it('lists the own addresses, hides one from the suggestions and brings it back; Webfleet rows are not touched', async () => {
    const changed = vi.fn();
    const book = new OwnAddressBook(asAppDatabase(db), changed);
    const listed = await book.list('salzgitter');
    expect(listed).toMatchObject({ total: 2, addresses: [{ name: 'Volkswagen AG Werk Salzgitter', active: true, useCount: 2 }] });
    const id = listed.addresses[0].id;

    expect(await book.setActive(id, false, actor)).toEqual({ id, active: false });
    expect(await searchAddresses(asAppDatabase(db), 'volkswagen salz')).toEqual([]);
    expect((await book.list('')).total).toBe(1);
    expect(await db.auditLog.findFirst({ where: { action: 'KNOWN_ADDRESS_HIDDEN' } })).toMatchObject({ entityId: id, actorRole: 'dispatcher' });
    // A hidden address is not learned again by the next tour.
    const again = await tour([{ type: 'LOAD', company: 'Volkswagen AG Werk Salzgitter', address: 'Industriestraße Nord 1, 38239 Salzgitter', city: 'Salzgitter', latitude: 52.19, longitude: 10.4, ...exact },
      { type: 'UNLOAD', company: 'Lieferant Zwickau', address: 'Reichenbacher Straße 80, 08056 Zwickau', city: 'Zwickau', latitude: 50.72, longitude: 12.49, ...exact }]);
    expect(await book.rememberTour(again.id, actor)).toMatchObject({ added: 0, counted: 2 });
    expect((await db.knownAddress.findUniqueOrThrow({ where: { id } })).active).toBe(false);

    expect(await book.setActive(id, true, actor)).toEqual({ id, active: true });
    expect(await db.auditLog.count({ where: { action: 'KNOWN_ADDRESS_RESTORED' } })).toBe(1);
    expect(changed).toHaveBeenCalledTimes(2);
    const webfleet = await db.knownAddress.findFirstOrThrow({ where: { source: 'WEBFLEET' } });
    expect(await book.setActive(webfleet.id, false, actor)).toBeNull();
    expect(await book.setActive('nope', false, actor)).toBeNull();
  });

  it('collects addresses of earlier tours: first only counts, then writes with one audit entry', async () => {
    const book = new OwnAddressBook(asAppDatabase(db));
    await tour([{ type: 'LOAD', company: 'Hydro Aluminium', address: 'Gewerbering 1, 08451 Crimmitschau', city: 'Crimmitschau', latitude: 50.81, longitude: 12.38, ...exact },
      { type: 'UNLOAD', company: 'AIM', address: 'Plohnbachstraße 15, 08485 Lengenfeld', city: 'Lengenfeld', latitude: 50.57, longitude: 12.36, ...exact }]);
    const before = await db.knownAddress.count();

    const counted = await book.backfill(false, actor);
    expect(counted).toMatchObject({ applied: false, added: 2 });
    expect(await db.knownAddress.count()).toBe(before);
    expect(await db.auditLog.count({ where: { action: 'KNOWN_ADDRESSES_BACKFILLED' } })).toBe(0);

    const applied = await book.backfill(true, { role: 'admin', sessionId: 's', dispatcherId: 'a1' });
    expect(applied).toMatchObject({ applied: true, added: 2 });
    expect(await db.knownAddress.count()).toBe(before + 2);
    expect(await db.auditLog.findFirst({ where: { action: 'KNOWN_ADDRESSES_BACKFILLED' } })).toMatchObject({ actorRole: 'admin' });
    expect(await book.backfill(false, actor)).toMatchObject({ added: 0 });
  });
});
