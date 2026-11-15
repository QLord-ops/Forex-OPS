import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { MockRoutingProvider, OsrmRoutingProvider, RoutingService } from '../src/services/routing.js';

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the address of a spot on the map', () => {
  it('asks Nominatim for the nearest address and answers with street, house number, postcode and town', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => answer({ display_name: 'long text', address: { road: 'Dr.-Rudolf-Leiding-Platz', house_number: '1', postcode: '34225', town: 'Baunatal', country: 'Deutschland' } }));
    const provider = new OsrmRoutingProvider(new MockRoutingProvider(), fetchImpl as typeof fetch, { nominatimMinIntervalMs: 0, nominatimBaseUrl: 'https://nominatim.test/' });
    expect(await new RoutingService(provider).reverseGeocode(51.2512345, 9.4112345)).toBe('Dr.-Rudolf-Leiding-Platz 1, 34225 Baunatal');
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(`${url.origin}${url.pathname}`).toBe('https://nominatim.test/reverse');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ lat: '51.25123', lon: '9.41123', format: 'jsonv2' });
  });

  it('falls back to the place name on a field road and to nothing in the sea', async () => {
    const field = new OsrmRoutingProvider(new MockRoutingProvider(), (async () => answer({ display_name: 'Feldweg, Bovenden', address: {} })) as typeof fetch, { nominatimMinIntervalMs: 0 });
    expect(await field.reverseGeocode(51.6, 9.9)).toBe('Feldweg, Bovenden');
    const sea = new OsrmRoutingProvider(new MockRoutingProvider(), (async () => answer({ error: 'Unable to geocode' })) as typeof fetch, { nominatimMinIntervalMs: 0 });
    expect(await sea.reverseGeocode(54.9, 6.5)).toBeNull();
  });

  it('hides the service\'s own error text and has no answer from a provider without reverse search', async () => {
    const broken = new OsrmRoutingProvider(new MockRoutingProvider(), (async () => { throw new Error('ECONNRESET nominatim internal detail'); }) as typeof fetch, { nominatimMinIntervalMs: 0 });
    await expect(broken.reverseGeocode(51.6, 9.9)).rejects.toMatchObject({ statusCode: 502, message: 'Сервис адресов временно недоступен.' });
    expect(await new RoutingService(new MockRoutingProvider()).reverseGeocode(51.6, 9.9)).toBeNull();
  });
});

describe('GET /geocode/reverse', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterAll(async () => { await Promise.all(apps.map((app) => app.close())); });

  it('refuses coordinates that are not on the globe before asking anybody', async () => {
    const app = await buildApp({ auth: { disabled: true } });
    apps.push(app);
    for (const query of ['lat=abc&lon=9', 'lat=91&lon=9', 'lat=51&lon=181', 'lat=51']) {
      expect((await app.inject({ method: 'GET', url: `/geocode/reverse?${query}` })).statusCode).toBe(400);
    }
  });

  it('needs a signed-in dispatcher', async () => {
    const app = await buildApp({ auth: { secret: 's'.repeat(32), origins: ['https://ops.test'] } });
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/geocode/reverse?lat=51&lon=9' })).statusCode).toBe(401);
  });
});
