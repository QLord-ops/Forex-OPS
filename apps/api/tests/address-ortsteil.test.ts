import { describe, expect, it, vi } from 'vitest';
import { buildAddressCandidates, ortsteilOf, resolveAddressWithFallback } from '../src/services/address-resolution.js';
import { RoutingError, type RoutingProvider } from '../src/services/routing.js';

// Owner, 16.11.2026: «Zachower Str. 4, Ketzin OT Tremmen» — «Адрес не найден». The free geocoder knows the Ortsteil
// «Tremmen», but neither the street nor «Ketzin OT Tremmen» written together.
const TREMMEN = { latitude: 52.509, longitude: 12.789 };
const input = { address: 'Zachower Str. 4, Ketzin OT Tremmen', city: 'Ketzin OT Tremmen', company: 'Lorberg Quality Plants GmbH & Co. KG' };
const nominatim = () => vi.fn(async (query: string) => {
  if (query === 'Tremmen') return { label: 'Tremmen, Ketzin/Havel, Havelland, Brandenburg, Deutschland', city: 'Ketzin/Havel', ...TREMMEN, provider: 'nominatim' };
  throw new RoutingError('Адрес не найден.', 404);
});

describe('a town with its Ortsteil (Ketzin OT Tremmen)', () => {
  it('splits into the town and the Ortsteil', () => {
    expect(ortsteilOf('Ketzin OT Tremmen')).toEqual({ full: 'Ketzin OT Tremmen', town: 'Ketzin', district: 'Tremmen' });
    expect(ortsteilOf('Zachower Str. 4, Ketzin OT Tremmen')).toMatchObject({ town: 'Ketzin', district: 'Tremmen' });
    expect(ortsteilOf('Braunschweig')).toBeNull();
  });

  it('asks the street in the Ortsteil and in the town before falling back to them', () => {
    const queries = buildAddressCandidates(input.address, input.city, input.company);
    expect(queries.slice(0, 4).map((item) => item.precision)).toEqual(['EXACT', 'STREET', 'EXACT', 'STREET']);
    expect(queries.map((item) => item.query)).toEqual(expect.arrayContaining(['Zachower straße 4, Tremmen', 'Zachower straße 4, Ketzin', 'Tremmen', 'Ketzin']));
  });

  it('is found at least at the Ortsteil instead of «Адрес не найден»', async () => {
    const result = await resolveAddressWithFallback({ geocode: nominatim() } as unknown as RoutingProvider, input);
    expect(result).toMatchObject({ ...TREMMEN, precision: 'CITY' });
  });

  it('takes the street from TomTom when the free geocoder has only the town', async () => {
    const findAddress = vi.fn(async () => ({ label: 'Zachower Straße 4, 14669 Ketzin/Havel', latitude: 52.511, longitude: 12.792, provider: 'tomtom-geocode', city: 'Ketzin/Havel', postalCode: '14669', exact: true }));
    const result = await resolveAddressWithFallback({ geocode: nominatim() } as unknown as RoutingProvider, input, undefined, [], [], { places: { findCompany: vi.fn(async () => null), findAddress } });
    expect(result).toMatchObject({ latitude: 52.511, provider: 'tomtom-geocode', precision: 'EXACT' });
    expect(findAddress).toHaveBeenCalledTimes(1);
  });

  it('a TomTom answer far from the town is dropped and the town is used', async () => {
    const findAddress = vi.fn(async () => ({ label: 'Zachower Straße 4, 80331 München', latitude: 48.14, longitude: 11.58, provider: 'tomtom-geocode', city: 'München', postalCode: '80331' }));
    const result = await resolveAddressWithFallback({ geocode: nominatim() } as unknown as RoutingProvider, input, undefined, [], [], { places: { findCompany: vi.fn(async () => null), findAddress } });
    expect(result).toMatchObject({ ...TREMMEN });
  });
});
