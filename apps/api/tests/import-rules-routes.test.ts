import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { registerImportRuleRoutes } from '../src/routes/import-rules.js';
import type { ImportLearningService } from '../src/services/import-learning.js';
import type { DispatcherRole } from '../src/services/dispatcher-auth.js';

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const calls: Array<[string, unknown]> = [];
const rule = { id: 'r1', kind: 'ALIAS', pattern: 'mb', value: 'Mercedes-Benz AG', active: true, hits: 2, applied: 0, builtIn: false, lastSeenAt: null, createdAt: new Date(), updatedAt: new Date() };
const service = {
  list: async () => [rule],
  correctionsSince: async () => 5,
  update: async (id: string, patch: unknown) => { calls.push(['update', { id, patch }]); return { ...rule, ...(patch as object) }; },
  remove: async (id: string) => { calls.push(['remove', id]); }
} as unknown as ImportLearningService;

async function build(role: DispatcherRole | null) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.dispatcherSession = role ? { token: 't', expiresAt: Number.MAX_SAFE_INTEGER, role, sessionId: 's', dispatcherId: 'd1', displayName: 'Test' } : null;
  });
  registerImportRuleRoutes(app, service);
  apps.push(app);
  return app;
}

it('lists learned and built-in rules for both roles and lets them switch or drop a rule', async () => {
  expect((await (await build(null)).inject({ method: 'GET', url: '/import-rules' })).statusCode).toBe(401);
  const dispatcher = await build('dispatcher');
  const list = (await dispatcher.inject({ method: 'GET', url: '/import-rules' })).json();
  expect(list.rules).toHaveLength(1);
  expect(list.builtIn).toEqual(expect.arrayContaining([{ kind: 'ALIAS', pattern: 'mb', value: 'Mercedes-Benz AG' }, { kind: 'IGNORE_LABEL', pattern: 'lg', value: 'Leergut' }]));
  expect(list.corrections).toEqual({ last7d: 5 });
  expect((await dispatcher.inject({ method: 'PATCH', url: '/import-rules/r1', payload: { active: false } })).json()).toMatchObject({ id: 'r1', active: false });
  expect((await dispatcher.inject({ method: 'DELETE', url: '/import-rules/r1' })).statusCode).toBe(204);
  expect(calls).toEqual([['update', { id: 'r1', patch: { active: false } }], ['remove', 'r1']]);
});
