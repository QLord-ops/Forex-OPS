import { describe, expect, it, vi } from 'vitest';
import { addressParts, type PlaceSearch } from '../src/services/address-check.js';
import { matchOf, resolveAddressWithFallback, sameStreet } from '../src/services/address-resolution.js';
import { OsrmRoutingProvider, RoutingError, type RoutingProvider } from '../src/services/routing.js';

// Owner, 16.11.2026: «увеличить точность анализа адресов по максимуму». TomTom first, field by field; any answer must
// be the printed street at the printed house and postcode; a busy free geocoder costs no stop its address.
const fuyao = { address: 'Laichinger Straße 2, 89150 Laichingen', city: '89150 Laichingen', company: 'Fuyao Europe GmbH' };
const FUYAO = { latitude: 48.4893, longitude: 9.6869 };
const notFound = () => vi.fn(async () => { throw new RoutingError('Адрес не найден.', 404); });
const places = (extra: Partial<PlaceSearch> = {}): PlaceSearch => ({ findCompany: vi.fn(async () => null), ...extra });
const tomTomHouse = (street = 'Laichinger Straße', houseNumber: string | null = '2', postalCode = '89150', at = FUYAO) => ({
  label: `${street} ${houseNumber ?? ''}, ${postalCode} Laichingen`, ...at, provider: 'tomtom-structured', city: 'Laichingen', postalCode, street, houseNumber, exact: Boolean(houseNumber)
});

describe('the printed address in parts', () => {
  it('takes the street named like a street, with its house number', () => {
    expect(addressParts('Halle 3, Eichenstraße 2b, 15537 Grünheide')).toMatchObject({ street: 'Eichenstraße', houseNumber: '2b', postalCode: '15537' });
    expect(addressParts('Sommerfeld 22-28, 45481 Mülheim an der Ruhr')).toMatchObject({ street: 'Sommerfeld', houseNumber: '22-28' });
    expect(addressParts('Zachower Str. 4, Ketzin OT Tremmen', 'Ketzin OT Tremmen')).toMatchObject({ street: 'Zachower Str', houseNumber: '4' });
  });

  it('calls a street the same however it is written, but not a similar one', () => {
    expect(sameStreet('Zachower Str', 'Zachower Straße')).toBe(true);
    expect(sameStreet('Eichenstrasse', 'Eichenstraße')).toBe(true);
    expect(sameStreet('Lehmanger', 'Am Lehmanger')).toBe(true);
    expect(sameStreet('Dr.-Kurt-Schumacher-Str.', 'Doktor-Kurt-Schumacher-Straße')).toBe(true);
    expect(sameStreet('Mercedestraße', 'Mercedesstraße')).toBe(true);
    expect(sameStreet('Lager', 'Lagerstraße')).toBe(false);
    expect(sameStreet('Hauptstraße', 'Hafenstraße')).toBe(false);
  });

  it('judges the house and the postcode', () => {
    const printed = addressParts('Sommerfeld 22-28, 45481 Mülheim an der Ruhr');
    expect(matchOf(printed, { street: 'Sommerfeld', houseNumber: '24', postalCode: '45481' })).toEqual({ street: 'same', house: 'same', postcode: 'same' });
    expect(matchOf(printed, { street: 'Sommerfeld', houseNumber: '40', postalCode: '45470' })).toEqual({ street: 'same', house: 'other', postcode: 'other' });
    expect(matchOf(printed, { street: 'Sommerfeld', houseNumber: null, postalCode: null })).toEqual({ street: 'same', house: 'missing', postcode: 'unknown' });
  });
});

describe('TomTom first, every answer checked against the Auftrag', () => {
  it('takes the house from TomTom without waiting for the free geocoder', async () => {
    const geocode = notFound();
    const findStructured = vi.fn(async () => tomTomHouse());
    const result = await resolveAddressWithFallback({ geocode } as unknown as RoutingProvider, fuyao, undefined, [], [], { places: places({ findStructured }) });
    expect(result).toMatchObject({ ...FUYAO, provider: 'tomtom-structured', precision: 'EXACT' });
    expect(findStructured).toHaveBeenCalledWith({ street: 'Laichinger Straße', houseNumber: '2', postalCode: '89150', city: 'Laichingen' });
  });

  it('drops a similar street and keeps looking', async () => {
    const findStructured = vi.fn(async () => tomTomHouse('Laichinger Weg'));
    const geocode = vi.fn(async () => ({ label: 'Laichinger Straße 2, 89150 Laichingen', ...FUYAO, provider: 'nominatim', city: 'Laichingen', postalCode: '89150', street: 'Laichinger Straße', houseNumber: '2' }));
    const result = await resolveAddressWithFallback({ geocode } as unknown as RoutingProvider, fuyao, undefined, [], [], { places: places({ findStructured }) });
    expect(result).toMatchObject({ provider: 'nominatim', precision: 'EXACT' });
    expect(result.attempts.join(' ')).toContain('другая улица, отброшено');
  });

  it('calls the right street without the printed house STREET, never EXACT, and prefers it to the town centre', async () => {
    const findStructured = vi.fn(async () => tomTomHouse('Laichinger Straße', null));
    const result = await resolveAddressWithFallback({ geocode: notFound() } as unknown as RoutingProvider, fuyao, undefined, [], [], { places: places({ findStructured }) });
    expect(result).toMatchObject({ provider: 'tomtom-structured', precision: 'STREET' });
  });

  it('drops a street under another postcode farther than its district', async () => {
    const findStructured = vi.fn(async () => tomTomHouse('Laichinger Straße', '2', '89073', { latitude: 48.4, longitude: 9.99 }));
    const geocode = vi.fn(async (query: string) => {
      if (query === '89150 Laichingen') return { label: '89150 Laichingen', ...FUYAO, provider: 'nominatim', city: 'Laichingen', postalCode: '89150' };
      throw new RoutingError('Адрес не найден.', 404);
    });
    const result = await resolveAddressWithFallback({ geocode } as unknown as RoutingProvider, fuyao, undefined, [], [], { places: places({ findStructured }) });
    expect(result.precision).toBe('POSTCODE_CITY');
    expect(result.attempts.join(' ')).toContain('индекс 89073, а не 89150, отброшено');
  });

  it('finds the stop through TomTom when the free geocoder refuses (429), instead of failing it', async () => {
    const geocode = vi.fn(async () => { throw new RoutingError('Картографический сервис вернул статус 429.', 502); });
    const findAddress = vi.fn(async () => ({ ...tomTomHouse(), provider: 'tomtom-geocode' }));
    const result = await resolveAddressWithFallback({ geocode } as unknown as RoutingProvider, fuyao, undefined, [], [], { places: places({ findAddress }) });
    expect(result).toMatchObject({ provider: 'tomtom-geocode', precision: 'EXACT' });
    // The search loop asked once; the real geocoder then rests, so the second opinion costs no request (see below).
    expect(result.attempts).toContain('бесплатный геокодер перегружен');
  });
});

describe('the free geocoder rests after it refused', () => {
  it('answers «busy» at once for two minutes after a 429, without asking again', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 }));
    const provider = new OsrmRoutingProvider(undefined, fetchImpl as unknown as typeof fetch, { allowMock: false, nominatimMinIntervalMs: 0 });
    await expect(provider.geocode('Laichinger Straße 2, 89150 Laichingen')).rejects.toMatchObject({ statusCode: 502 });
    await expect(provider.geocode('Eichenstraße 2b, 15537 Grünheide')).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider.geocoderPaused()).toBe(true);
    expect(provider.geocoderPaused(Date.now() + 121_000)).toBe(false);
  });

  it('reads the street and house number the free geocoder matched', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ lat: '48.4893', lon: '9.6869', display_name: 'Laichinger Straße 2, 89150 Laichingen',
      address: { road: 'Laichinger Straße', house_number: '2', town: 'Laichingen', postcode: '89150' } }]), { status: 200 }));
    const provider = new OsrmRoutingProvider(undefined, fetchImpl as unknown as typeof fetch, { allowMock: false, nominatimMinIntervalMs: 0 });
    expect(await provider.geocode('Laichinger Straße 2, 89150 Laichingen')).toMatchObject({ street: 'Laichinger Straße', houseNumber: '2', postalCode: '89150' });
  });
});

describe('a second source on the house TomTom found', () => {
  const nominatimAt = (at: { latitude: number; longitude: number }, houseNumber: string | null) => vi.fn(async () => ({
    label: 'Laichinger Straße, 89150 Laichingen', ...at, provider: 'nominatim', city: 'Laichingen', postalCode: '89150', street: 'Laichinger Straße', houseNumber
  }));

  it('flags the place when the free geocoder puts the same house far away', async () => {
    const geocode = nominatimAt({ latitude: 48.5, longitude: 9.72 }, '2');
    const result = await resolveAddressWithFallback({ geocode } as unknown as RoutingProvider, fuyao, undefined, [], [], { places: places({ findStructured: vi.fn(async () => tomTomHouse()) }) });
    expect(result.second).toMatchObject({ status: 'DIFFER' });
  });

  it('agrees when both find the house; a street-middle answer without the number is no opinion', async () => {
    const same = await resolveAddressWithFallback({ geocode: nominatimAt(FUYAO, '2') } as unknown as RoutingProvider, fuyao, undefined, [], [], { places: places({ findStructured: vi.fn(async () => tomTomHouse()) }) });
    expect(same.second).toMatchObject({ status: 'AGREE' });
    const middle = await resolveAddressWithFallback({ geocode: nominatimAt({ latitude: 48.5, longitude: 9.72 }, null) } as unknown as RoutingProvider, fuyao, undefined, [], [], { places: places({ findStructured: vi.fn(async () => tomTomHouse()) }) });
    expect(middle.second).toBeUndefined();
  });

  it('does not keep the dispatcher waiting for a busy queue', async () => {
    const geocode = vi.fn(() => new Promise<never>(() => undefined));
    const started = Date.now();
    const result = await resolveAddressWithFallback({ geocode } as unknown as RoutingProvider, fuyao, undefined, [], [], { places: places({ findStructured: vi.fn(async () => tomTomHouse()) }) });
    expect(result).toMatchObject({ precision: 'EXACT' });
    expect(result.second).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
