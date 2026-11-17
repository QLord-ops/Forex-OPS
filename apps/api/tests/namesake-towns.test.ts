import { describe, expect, it, vi } from 'vitest';
import type { AddressRuleRecord } from '../src/services/address-rules.js';
import { resolveAddressWithFallback } from '../src/services/address-resolution.js';
import { OsrmRoutingProvider, RoutingError, type RoutingProvider } from '../src/services/routing.js';

// Owner, 17.11.2026: a «15370 Petershagen» stop (by Berlin) drawn at Petershagen by Minden (32469), 300 km west.
// Free text «15370 Petershagen» comes back as the bigger namesake, so the town is asked by its postcode alone.
const MINDEN = { latitude: 52.376, longitude: 8.97 };
const BERLIN_SIDE = { latitude: 52.526, longitude: 13.783 };
const namesake = (postalCode: string | null = '32469') => ({ label: 'Petershagen, Minden-Lübbecke', ...MINDEN, provider: 'nominatim', city: 'Petershagen', postalCode });
const ownArea = { label: '15370, Petershagen/Eggersdorf', ...BERLIN_SIDE, provider: 'nominatim', city: 'Petershagen/Eggersdorf', postalCode: '15370' };

describe('a town that shares its name with a bigger one', () => {
  it('never takes the namesake for the printed postcode, and falls back to the postcode area itself', async () => {
    const geocode = vi.fn(async () => namesake());
    const geocodePostcode = vi.fn(async () => ownArea);
    const result = await resolveAddressWithFallback({ geocode, geocodePostcode } as unknown as RoutingProvider,
      { address: 'Petershagen', city: '15370 Petershagen', company: 'Muster Logistik' });
    expect(geocodePostcode).toHaveBeenCalledWith('15370');
    expect(result).toMatchObject({ ...BERLIN_SIDE, precision: 'POSTCODE_CITY' });
    expect(result.attempts.join(' ')).toContain('км от 15370 Petershagen, отброшено');
  });

  it('measures a namesake answer without a postcode instead of trusting the town name', async () => {
    const geocode = vi.fn(async () => namesake(null));
    const result = await resolveAddressWithFallback({ geocode, geocodePostcode: vi.fn(async () => ownArea) } as unknown as RoutingProvider,
      { address: 'Petershagen', city: '15370 Petershagen' });
    expect(result).toMatchObject(BERLIN_SIDE);
  });

  it('drops a rule learned at the namesake', async () => {
    const rule = { kind: 'SITE', pattern: 'muster logistik petershagen', company: 'Muster Logistik', street: 'Industriestraße 12', postalCode: null, city: 'Petershagen',
      latitude: MINDEN.latitude, longitude: MINDEN.longitude, builtIn: false } as unknown as AddressRuleRecord;
    const geocode = vi.fn(async () => { throw new RoutingError('Адрес не найден.', 404); });
    const result = await resolveAddressWithFallback({ geocode, geocodePostcode: vi.fn(async () => ownArea) } as unknown as RoutingProvider,
      { address: 'Petershagen', city: '15370 Petershagen', company: 'Muster Logistik' }, undefined, [rule]);
    expect(result).toMatchObject(BERLIN_SIDE);
    expect(result.attempts.join(' ')).toContain('правило «muster logistik petershagen» отброшено');
  });

  it('does not accept another postcode while the town cannot be found (busy geocoder)', async () => {
    const geocode = vi.fn(async () => { throw new RoutingError('Сервис адресов перегружен.', 503); });
    const findStructured = vi.fn(async () => ({ label: 'Industriestraße 12, 32469 Petershagen', ...MINDEN, provider: 'tomtom-structured', city: 'Petershagen',
      postalCode: '32469', street: 'Industriestraße', houseNumber: '12', exact: true }));
    await expect(resolveAddressWithFallback({ geocode } as unknown as RoutingProvider, { address: 'Industriestraße 12, 15370 Petershagen', city: 'Petershagen' }, undefined, [], [],
      { places: { findCompany: vi.fn(async () => null), findStructured } })).rejects.toMatchObject({ statusCode: 503 });
  });

  it('still takes the town text when it names the printed postcode (no postcode search available)', async () => {
    const geocode = vi.fn(async (query: string) => {
      if (query === '15370 Petershagen') return ownArea;
      throw new RoutingError('Адрес не найден.', 404);
    });
    const result = await resolveAddressWithFallback({ geocode } as unknown as RoutingProvider, { address: 'Petershagen', city: '15370 Petershagen' });
    expect(result).toMatchObject({ ...BERLIN_SIDE, precision: 'POSTCODE_CITY' });
  });
});

describe('the free geocoder asked for a postcode', () => {
  it('asks the postcode field alone and keeps only that postcode', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL) => {
      urls.push(url.toString());
      const code = url.searchParams.get('postalcode');
      return new Response(JSON.stringify([{ lat: '52.526', lon: '13.783', display_name: `${code}, Petershagen/Eggersdorf`,
        address: { village: 'Petershagen', postcode: code === '15370' ? '15370' : '32469' } }]), { status: 200 });
    });
    const provider = new OsrmRoutingProvider(undefined, fetchImpl as unknown as typeof fetch, { allowMock: false, nominatimMinIntervalMs: 0 });
    expect(await provider.geocodePostcode('15370')).toMatchObject({ postalCode: '15370', latitude: 52.526 });
    expect(await provider.geocodePostcode('15236')).toBeNull();
    expect(await provider.geocodePostcode('Petershagen')).toBeNull();
    const asked = new URL(urls[0]);
    expect(asked.searchParams.get('q')).toBeNull();
    expect(asked.searchParams.get('countrycodes')).toBe('de');
  });
});
