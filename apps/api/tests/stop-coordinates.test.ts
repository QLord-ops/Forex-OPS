import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { resolveAddressWithFallback } from '../src/services/address-resolution.js';
import { BUILT_IN_RULES, findSiteRule, type AddressRuleRecord } from '../src/services/address-rules.js';
import { ReplanningService } from '../src/services/replanning.js';
import type { GeocodeResult } from '../src/domain.js';
import { MockRoutingProvider, RoutingError } from '../src/services/routing.js';
import { StopCoordinatesService } from '../src/services/stop-coordinates.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

const LUDWIGSFELDE = { latitude: 52.3, longitude: 13.25 };
const HAMBURG = { latitude: 53.55, longitude: 10.0 };
const place = (name: string, city: string, point: { latitude: number; longitude: number }): GeocodeResult => ({ label: name, city, ...point, provider: 'nominatim' });

/** Nominatim as it answered on 09.11.2026: "Lager, Ludwigsfelde" found a Lagerstraße in Hamburg. */
class WrongTownRouting extends MockRoutingProvider {
  readonly queries: string[] = [];
  async geocode(query: string) {
    this.queries.push(query);
    if (/^Lager, (?:14974 )?Ludwigsfelde$/i.test(query)) return place('Lagerstraße, 20095 Hamburg, Deutschland', 'Hamburg', HAMBURG);
    if (/Ludwigsfelde/i.test(query)) return place(`${query}, Deutschland`, 'Ludwigsfelde', LUDWIGSFELDE);
    if (/Hamburg/i.test(query)) return place(`${query}, Deutschland`, 'Hamburg', HAMBURG);
    throw new RoutingError('Адрес не найден.', 404);
  }
}

describe('a place far from its own town is not accepted', () => {
  it('drops a geocoder hit in another town and takes the postcode and town instead', async () => {
    const routing = new WrongTownRouting();
    const result = await resolveAddressWithFallback(routing, { address: 'Lager', city: 'D 14974 Ludwigsfelde', company: 'Schnellecke Transportlogistik GmbH' });
    expect(result).toMatchObject({ latitude: LUDWIGSFELDE.latitude, longitude: LUDWIGSFELDE.longitude, precision: 'POSTCODE_CITY' });
    expect(result.attempts.join(' | ')).toMatch(/Hamburg.*км от 14974 Ludwigsfelde, отброшено/);
  });

  it('drops a learned rule whose point lies in another town and geocodes the address instead', async () => {
    const routing = new WrongTownRouting();
    const rules: AddressRuleRecord[] = [...BUILT_IN_RULES, { pattern: 'schnellecke transportlogistik gmbh d 14974 ludwigsfelde', kind: 'SITE', company: 'Schnellecke Transportlogistik GmbH',
      street: 'Lagerstraße 1', postalCode: '20095', city: 'Hamburg', latitude: HAMBURG.latitude, longitude: HAMBURG.longitude, requiresTermin: false }];
    const result = await resolveAddressWithFallback(routing, { address: 'Rudolf-Diesel-Straße 2, D 14974 Ludwigsfelde', city: 'D 14974 Ludwigsfelde', company: 'Schnellecke Transportlogistik GmbH' }, undefined, rules);
    expect(result).toMatchObject({ latitude: LUDWIGSFELDE.latitude, precision: 'EXACT', provider: 'nominatim' });
    expect(result.attempts[0]).toMatch(/правило «schnellecke transportlogistik gmbh d 14974 ludwigsfelde» отброшено: \d+ км/);
  });

  it('keeps a rule and a hit that lie in the town, without asking the geocoder about the town when the hit names it', async () => {
    const routing = new WrongTownRouting();
    const rules: AddressRuleRecord[] = [...BUILT_IN_RULES, { pattern: 'mercedes benz ag ludwigsfelde', kind: 'SITE', company: 'Mercedes-Benz AG', street: 'Rudolf-Diesel-Straße 2', postalCode: '14974', city: 'Ludwigsfelde',
      latitude: 52.31, longitude: 13.26, requiresTermin: true }];
    const rule = await resolveAddressWithFallback(routing, { address: 'Ludwigsfelde', city: 'Ludwigsfelde', company: 'Mercedes-Benz AG' }, undefined, rules);
    expect(rule).toMatchObject({ provider: 'address-rule', latitude: 52.31 });
    routing.queries.length = 0;
    const hit = await resolveAddressWithFallback(routing, { address: 'Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde', city: 'Ludwigsfelde' });
    expect(hit.precision).toBe('EXACT');
    expect(routing.queries).toEqual(['Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde']);
  });

  it('a rule learned under the bare company name does not reach into another town', () => {
    const rules: AddressRuleRecord[] = [{ pattern: 'schnellecke', kind: 'SITE', company: 'Schnellecke', street: 'Lagerstraße 1', postalCode: '20095', city: 'Hamburg', latitude: HAMBURG.latitude, longitude: HAMBURG.longitude, requiresTermin: false },
      { pattern: 'blg', kind: 'SITE', company: 'BLG', street: 'Senator-Bortscheller-Straße 1', postalCode: '28197', city: null, latitude: 53.1, longitude: 8.75, requiresTermin: true }];
    expect(findSiteRule('Schnellecke', 'Ludwigsfelde', rules)).toBeNull();
    expect(findSiteRule('Schnellecke', 'Hamburg', rules)?.pattern).toBe('schnellecke');
    expect(findSiteRule('Schnellecke', null, rules)?.pattern).toBe('schnellecke');
    // No town on the rule: it still applies anywhere, as before.
    expect(findSiteRule('BLG', 'Bremen', rules)?.pattern).toBe('blg');
  });
});

describe('stops drawn in the wrong town are found and moved', () => {
  let directory: string, db: PrismaClient;
  const now = new Date('2026-11-09T14:00:00Z');
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-stop-coordinates-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
  });
  afterEach(async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); });

  it('lists the stop whose point is 250 km from its town, moves it and redraws the route of the active tour', async () => {
    const routing = new WrongTownRouting();
    const replanning = new ReplanningService(asAppDatabase(db), routing);
    const service = new StopCoordinatesService(asAppDatabase(db), routing, async () => BUILT_IN_RULES, replanning);
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'B-CY7446' } });
    const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: '71123726', status: 'ACTIVE' } });
    const load = await db.stop.create({ data: { tourId: tour.id, sequence: 1, type: 'LOAD', address: 'Wörth', city: 'Wörth', latitude: 49.05, longitude: 8.27, completedAt: now } });
    const unload = await db.stop.create({ data: { tourId: tour.id, sequence: 2, type: 'UNLOAD', company: 'Schnellecke Transportlogistik GmbH', address: 'Lager', city: 'D 14974 Ludwigsfelde',
      resolvedAddress: 'Lagerstraße, 20095 Hamburg, Deutschland', geocodeProvider: 'nominatim', ...HAMBURG } });
    const leg = await db.leg.create({ data: { tourId: tour.id, fromStopId: load.id, toStopId: unload.id, status: 'ACTIVE', startedAt: now, routeGeometry: JSON.stringify([load, unload]), distanceMeters: 650_000, routingDurationSeconds: 7 * 3600, simulatedDurationSeconds: 7 * 3600 } });

    const issues = await service.check(now);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ stopId: unload.id, vehicleNumber: 'B-CY7446', current: { resolvedAddress: 'Lagerstraße, 20095 Hamburg, Deutschland' }, proposed: { latitude: LUDWIGSFELDE.latitude, precision: 'POSTCODE_CITY' } });
    expect(issues[0].distanceKm).toBeGreaterThan(200);

    const result = await service.fix([unload.id], { role: 'admin', sessionId: 's1' }, now);
    expect(result.fixed).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    const moved = await db.stop.findUniqueOrThrow({ where: { id: unload.id } });
    expect(moved).toMatchObject({ latitude: LUDWIGSFELDE.latitude, longitude: LUDWIGSFELDE.longitude, geocodePrecision: 'POSTCODE_CITY' });
    // The old leg to Hamburg is gone; the new active leg ends at Ludwigsfelde.
    expect(await db.leg.findUnique({ where: { id: leg.id } })).toBeNull();
    const legs = await db.leg.findMany({ where: { tourId: tour.id } });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ toStopId: unload.id, status: 'ACTIVE' });
    expect((JSON.parse(legs[0].routeGeometry) as Array<{ latitude: number; longitude: number }>).at(-1)).toMatchObject(LUDWIGSFELDE);
    expect(await db.auditLog.count({ where: { action: 'STOP_COORDINATES_FIXED' } })).toBe(1);
    expect(await service.check(now)).toEqual([]);
  });

  it('redraws the waiting legs of a queued tour when no tour is active, and leaves arrived stops alone', async () => {
    const routing = new WrongTownRouting();
    const route = vi.spyOn(routing, 'calculateRoute');
    const service = new StopCoordinatesService(asAppDatabase(db), routing, async () => BUILT_IN_RULES, new ReplanningService(asAppDatabase(db), routing));
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'Q-1' } });
    const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: 'Q', status: 'QUEUED' } });
    const load = await db.stop.create({ data: { tourId: tour.id, sequence: 1, type: 'LOAD', address: 'Lager', city: 'D 14974 Ludwigsfelde', ...HAMBURG, arrivedAt: now } });
    const unload = await db.stop.create({ data: { tourId: tour.id, sequence: 2, type: 'UNLOAD', address: 'Lager', city: 'D 14974 Ludwigsfelde', ...HAMBURG } });
    const waiting = await db.leg.create({ data: { tourId: tour.id, fromStopId: load.id, toStopId: unload.id, status: 'WAITING', routeGeometry: '[]', distanceMeters: 1, routingDurationSeconds: 1, simulatedDurationSeconds: 1 } });
    const issues = await service.check(now);
    expect(issues.map((issue) => issue.stopId)).toEqual([unload.id]);
    await service.fix([unload.id], undefined, now);
    expect((await db.stop.findUniqueOrThrow({ where: { id: load.id } })).latitude).toBe(HAMBURG.latitude);
    expect((await db.stop.findUniqueOrThrow({ where: { id: unload.id } })).latitude).toBe(LUDWIGSFELDE.latitude);
    expect(route).toHaveBeenCalledTimes(1);
    expect((await db.leg.findUniqueOrThrow({ where: { id: waiting.id } })).distanceMeters).toBeGreaterThan(100_000);
  });
});
