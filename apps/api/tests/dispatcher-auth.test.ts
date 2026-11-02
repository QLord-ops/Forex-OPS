import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { hashDispatcherPassword, registerDispatcherAuth, requireDispatcherRoles } from '../src/services/dispatcher-auth.js';

const passwordHash = hashDispatcherPassword('test password');
const adminPasswordHash = hashDispatcherPassword('admin test password');
async function fixture() {
  let now = Date.UTC(2026, 9, 16);
  const counts = new Map<string, number>();
  const app = Fastify();
  registerDispatcherAuth(app, { apiQuota: {
    upsert: async ({ where, create, update }) => {
      const used = counts.has(where.id) ? counts.get(where.id)! + update.used.increment : create.used;
      counts.set(where.id, used); return { used };
    },
    findUnique: async ({ where }) => counts.has(where.id) ? { used: counts.get(where.id)! } : null
  } }, { dispatcherPasswordHash: passwordHash, adminPasswordHash, secret: 'a'.repeat(32), origins: ['https://ops.test'], now: () => now });
  app.get('/health', async () => ({ ok: true }));
  app.get('/vehicles', async () => []);
  app.post('/vehicles', async () => ({ created: true }));
  app.post('/admin', { preHandler: requireDispatcherRoles('admin') }, async () => ({ allowed: true }));
  await app.ready();
  return { app, advance: (ms: number) => { now += ms; } };
}
describe('dispatcher auth', () => {
  it('protects operations, validates CSRF, and expires signed sessions', async () => {
    const { app, advance } = await fixture();
    try {
      expect((await app.inject('/health')).statusCode).toBe(200);
      expect((await app.inject('/vehicles')).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://evil.test' }, payload: { password: 'test password' } })).statusCode).toBe(403);
      const login = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://ops.test' }, payload: { password: 'test password' } });
      expect(login.statusCode).toBe(200);
      expect(login.json().role).toBe('dispatcher');
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      expect(login.headers['set-cookie']).toContain('HttpOnly');
      expect((await app.inject({ url: '/vehicles', headers: { cookie } })).statusCode).toBe(200);
      const headers = { cookie, origin: 'https://ops.test' };
      expect((await app.inject({ method: 'POST', url: '/vehicles', headers, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/vehicles', headers: { ...headers, 'x-csrf-token': login.json().csrfToken }, payload: {} })).statusCode).toBe(200);
      expect((await app.inject({ url: '/vehicles', headers: { cookie: `${cookie}x` } })).statusCode).toBe(401);
      advance(12 * 60 * 60_000);
      expect((await app.inject({ url: '/vehicles', headers: { cookie } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it('issues role-bound sessions and enforces admin-only actions', async () => {
    const { app } = await fixture();
    try {
      const dispatcher = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://ops.test' }, payload: { password: 'test password' } });
      const dispatcherHeaders = { origin: 'https://ops.test', cookie: String(dispatcher.headers['set-cookie']).split(';')[0], 'x-csrf-token': dispatcher.json().csrfToken };
      expect((await app.inject({ method: 'POST', url: '/admin', headers: dispatcherHeaders })).statusCode).toBe(403);

      const admin = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://ops.test' }, payload: { password: 'admin test password' } });
      expect(admin.json().role).toBe('admin');
      const adminHeaders = { origin: 'https://ops.test', cookie: String(admin.headers['set-cookie']).split(';')[0], 'x-csrf-token': admin.json().csrfToken };
      expect((await app.inject({ method: 'POST', url: '/admin', headers: adminHeaders })).statusCode).toBe(200);
      const session = await app.inject({ url: '/auth/session', headers: { cookie: adminHeaders.cookie } });
      expect(session.json().role).toBe('admin');
    } finally { await app.close(); }
  });
  it('limits repeated incorrect passwords through persistent quota counters', async () => {
    const { app } = await fixture();
    try {
      for (let index = 0; index < 10; index++) expect((await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://ops.test' }, payload: { password: 'wrong' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://ops.test' }, payload: { password: 'test password' } })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
  it('does not count successful logins against the limit', async () => {
    const { app } = await fixture();
    try {
      for (let index = 0; index < 12; index++) expect((await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://ops.test' }, payload: { password: 'test password' } })).statusCode).toBe(200);
      for (let index = 0; index < 9; index++) expect((await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://ops.test' }, payload: { password: 'wrong' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://ops.test' }, payload: { password: 'test password' } })).statusCode).toBe(200);
    } finally { await app.close(); }
  }, 20_000);
  it('revokes the session on logout so the old cookie stops working', async () => {
    const { app } = await fixture();
    try {
      const login = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://ops.test' }, payload: { password: 'test password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      expect((await app.inject({ url: '/vehicles', headers: { cookie } })).statusCode).toBe(200);
      await app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: 'https://ops.test', cookie, 'x-csrf-token': login.json().csrfToken } });
      expect((await app.inject({ url: '/vehicles', headers: { cookie } })).statusCode).toBe(401);
      expect((await app.inject({ url: '/auth/session', headers: { cookie } })).json().authenticated).toBe(false);
    } finally { await app.close(); }
  });
  it('clears the cookie on logout and fails closed when unconfigured', async () => {
    const { app } = await fixture();
    try {
      const login = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://ops.test' }, payload: { password: 'test password' } });
      const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { origin: 'https://ops.test', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken } });
      expect(logout.statusCode).toBe(200); expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    } finally { await app.close(); }
    const closed = Fastify();
    registerDispatcherAuth(closed, { apiQuota: { upsert: async () => ({ used: 1 }), findUnique: async () => null } }, { passwordHash: '', secret: '' });
    expect((await closed.inject('/auth/session')).statusCode).toBe(503);
    await closed.close();
  });
});
