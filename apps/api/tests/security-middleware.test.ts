import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashDispatcherPassword } from '../src/services/dispatcher-auth.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
});

describe('security middleware', () => {
  it('sets security headers and only reflects allowed CORS origins', async () => {
    const app = await buildApp({ auth: { disabled: true } });
    apps.push(app);

    const allowed = await app.inject({ url: '/health', headers: { origin: 'http://localhost:5173' } });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');

    const rejected = await app.inject({ url: '/health', headers: { origin: 'https://evil.test' } });
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('enforces the strict import limit before parsing more uploads', async () => {
    const app = await buildApp({ auth: { disabled: true } });
    apps.push(app);
    for (let index = 0; index < 5; index += 1) {
      expect((await app.inject({ method: 'POST', url: '/imports/excel/preview' })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/imports/excel/preview' })).statusCode).toBe(429);
  });

  it('keeps the event stream behind the signed session hook', async () => {
    const app = await buildApp({ auth: {
      dispatcherPasswordHash: hashDispatcherPassword('test password'),
      secret: 's'.repeat(32),
      origins: ['https://ops.test']
    } });
    apps.push(app);
    expect((await app.inject('/events/stream')).statusCode).toBe(401);
  });
});
