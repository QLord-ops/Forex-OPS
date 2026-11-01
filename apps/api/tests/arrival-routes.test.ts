import { afterAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterAll(async () => { await Promise.all(apps.map((app) => app.close())); });

it('validates the arrival zone and revert input before touching data', async () => {
  const app = await buildApp({ auth: { disabled: true } });
  apps.push(app);
  const radius = (body: unknown) => app.inject({ method: 'PUT', url: '/stops/s1/arrival-radius', payload: body as object });
  expect((await radius({ radiusMeters: 50 })).statusCode).toBe(400);
  expect((await radius({ radiusMeters: 9000 })).statusCode).toBe(400);
  expect((await radius({ radiusMeters: 'wide' })).statusCode).toBe(400);
  const revert = await app.inject({ method: 'POST', url: '/stops/s1/arrival/revert', payload: { reason: 'x'.repeat(301) } });
  expect(revert.statusCode).toBe(400);
});

it('requires a dispatcher session for revert and zone changes', async () => {
  const app = await buildApp({ auth: { origins: ['http://localhost:5173'], dispatcherPasswordHash: 'scrypt:' + '0'.repeat(32) + ':' + '0'.repeat(128), secret: 's'.repeat(40) } });
  apps.push(app);
  const headers = { origin: 'http://localhost:5173' };
  expect((await app.inject({ method: 'POST', url: '/stops/s1/arrival/revert', headers, payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'PUT', url: '/stops/s1/arrival-radius', headers, payload: { radiusMeters: 500 } })).statusCode).toBe(401);
});
