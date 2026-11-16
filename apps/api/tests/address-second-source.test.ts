import { describe, expect, it, vi } from 'vitest';
import { TomTomPlaceSearch, type PlaceSearch } from '../src/services/address-check.js';
import { resolveAddressWithFallback } from '../src/services/address-resolution.js';
import type { RoutingProvider } from '../src/services/routing.js';

// Owner, 15.11.2026: an address is trusted when two independent services put it in the same place.
const HERE = { latitude: 52.16, longitude: 10.41 };
const routing = (provider = 'nominatim') => ({ geocode: vi.fn(async (query: string) => ({ label: query, city: 'Salzgitter', postalCode: '38239', ...HERE, provider })) }) as unknown as RoutingProvider;
const search = (answer: { latitude: number; longitude: number } | null) => ({
  findCompany: vi.fn(async () => null),
  findAddress: vi.fn(async (_query: string) => answer ? { label: 'Industriestraße Nord 12, 38239 Salzgitter', provider: 'tomtom-geocode', ...answer } : null)
}) satisfies PlaceSearch;
const input = { address: 'Industriestraße Nord 12, 38239 Salzgitter', city: 'Salzgitter', company: 'MAN' };

describe('a second opinion on an address', () => {
  it('agrees when TomTom puts the address within 500 m, and is asked with the postcode in the query', async () => {
    const places = search({ latitude: 52.162, longitude: 10.411 });
    const result = await resolveAddressWithFallback(routing(), input, undefined, [], [], { places });
    expect(result.second).toMatchObject({ status: 'AGREE' });
    expect(places.findAddress).toHaveBeenCalledWith('Industriestraße Nord 12, 38239 Salzgitter');
  });

  it('differs when the two are farther apart, and says where the other one is', async () => {
    const result = await resolveAddressWithFallback(routing(), input, undefined, [], [], { places: search({ latitude: 52.19, longitude: 10.41 }) });
    expect(result.second).toMatchObject({ status: 'DIFFER', latitude: 52.19, label: 'Industriestraße Nord 12, 38239 Salzgitter' });
    expect((result.second as { meters: number }).meters).toBeGreaterThan(3000);
    // The point on the map stays the first source's: the dispatcher decides.
    expect(result).toMatchObject(HERE);
  });

  it('says nothing when the second source has no answer, is off, or fails', async () => {
    expect((await resolveAddressWithFallback(routing(), input, undefined, [], [], { places: search(null) })).second).toBeUndefined();
    expect((await resolveAddressWithFallback(routing(), input, undefined, [], [], {})).second).toBeUndefined();
    const broken: PlaceSearch = { findCompany: vi.fn(async () => null), findAddress: vi.fn(async () => { throw new Error('quota'); }) };
    expect((await resolveAddressWithFallback(routing(), input, undefined, [], [], { places: broken })).second).toBeUndefined();
  });

  it('is not asked about a place the fleet already knows', async () => {
    const places = search({ latitude: 52.19, longitude: 10.41 });
    const book = [{ name: 'MAN', street: 'Industriestraße Nord 12', postalCode: '38239', city: 'Salzgitter', ...HERE, provider: 'gps-stay' }];
    const result = await resolveAddressWithFallback(routing(), input, undefined, [], book, { places });
    expect(result.second).toBeUndefined();
    expect(places.findAddress).not.toHaveBeenCalled();
  });
});

describe('TomTom as the second geocoder', () => {
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const config = { apiKey: 'test-key', enabled: true, baseUrl: 'https://tomtom.test/' };

  it('takes a street-level hit and ignores a town', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => answer({ results: [{ type: 'Point Address', position: { lat: 52.16, lon: 10.41 },
      address: { freeformAddress: 'Industriestraße Nord 12, 38239 Salzgitter', municipality: 'Salzgitter', postalCode: '38239' } }] }));
    const found = await new TomTomPlaceSearch(fetchImpl as typeof fetch, config).findAddress('Industriestraße Nord 12, 38239 Salzgitter');
    expect(found).toMatchObject({ latitude: 52.16, longitude: 10.41, provider: 'tomtom-geocode', postalCode: '38239' });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toContain('/search/2/geocode/');
    expect(url.searchParams.get('countrySet')).toBe('DE');

    const town = new TomTomPlaceSearch((async () => answer({ results: [{ type: 'Geography', position: { lat: 52.15, lon: 10.33 }, address: { freeformAddress: 'Salzgitter' } }] })) as typeof fetch, config);
    expect(await town.findAddress('Unbekannte Straße 1, 38239 Salzgitter')).toBeNull();
  });

  it('asks once for the same address, stops at the daily cap, and is off without the key', async () => {
    const fetchImpl = vi.fn(async () => answer({ results: [{ type: 'Street', position: { lat: 1, lon: 1 }, address: {} }] }));
    const capped = new TomTomPlaceSearch(fetchImpl as typeof fetch, { ...config, dailyCap: 1 });
    await capped.findAddress('A 1, 12345 X');
    await capped.findAddress('A 1, 12345 X');
    expect(await capped.findAddress('B 2, 12345 X')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await new TomTomPlaceSearch(fetchImpl as typeof fetch, { enabled: true, apiKey: '' }).findAddress('A 1, 12345 X')).toBeNull();
  });
});
