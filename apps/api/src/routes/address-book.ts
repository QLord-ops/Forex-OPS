import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { searchAddresses, type AddressBookSync } from '../services/address-book.js';
import type { AuditActor } from '../services/audit-log.js';
import { requireDispatcherRoles } from '../services/dispatcher-auth.js';
import type { OwnAddressBook } from '../services/own-addresses.js';

function actorOf(request: FastifyRequest): AuditActor {
  const session = request.dispatcherSession;
  if (!session) throw Object.assign(new Error('Войдите в диспетчерскую.'), { statusCode: 401 });
  return { role: session.role, sessionId: session.sessionId, dispatcherId: session.dispatcherId };
}

const PERMISSION_TEXT = 'У пользователя Webfleet нет права читать адреса: его выдаёт администратор Webfleet (Adressen → Lesen).';

/** Saved addresses for suggestions (Webfleet address book + learned sites), the sync status and the admin refresh. */
export function registerAddressBookRoutes(app: FastifyInstance, prisma: PrismaClient, sync: AddressBookSync, own?: OwnAddressBook) {
  if (own) {
    // The fleet's own addresses, remembered from confirmed tours.
    app.get('/addresses/own', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async (request) => {
      const query = z.object({ q: z.string().trim().max(120).default(''), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
      return own.list(query.q, query.limit);
    });

    app.patch('/addresses/:id', { preHandler: requireDispatcherRoles('admin') }, async (request, reply) => {
      const { id } = z.object({ id: z.string().trim().min(1).max(64) }).parse(request.params);
      const { active } = z.object({ active: z.boolean() }).strict().parse(request.body);
      const saved = await own.setActive(id, active, actorOf(request));
      if (!saved) return reply.status(404).send({ error: 'Такого своего адреса нет. Адреса Webfleet меняются в Webfleet.' });
      return saved;
    });

    // Without `apply` it only counts. With it the addresses of earlier tours are written: the admin presses it after a backup.
    app.post('/addresses/own/backfill', { preHandler: requireDispatcherRoles('admin'), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request) => {
      const { apply } = z.object({ apply: z.boolean().default(false) }).strict().parse(request.body ?? {});
      return own.backfill(apply, actorOf(request));
    });
  }

  app.get('/addresses/search', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const query = z.object({ q: z.string().trim().max(120).default(''), limit: z.coerce.number().int().min(1).max(20).default(8) }).parse(request.query);
    return { suggestions: await searchAddresses(prisma, query.q, query.limit) };
  });

  // Only a counter for ranking the most used addresses first: no operational data changes, like a view.
  app.post('/addresses/:id/used', async (request) => {
    const { id } = z.object({ id: z.string().trim().min(1).max(64) }).parse(request.params);
    if (id.startsWith('rule:')) return { ok: true };
    await prisma.knownAddress.updateMany({ where: { id }, data: { useCount: { increment: 1 } } });
    return { ok: true };
  });

  app.get('/integrations/webfleet/address-book', async () => {
    const state = await sync.state();
    return { ...state, message: state.error === 'PERMISSION' ? PERMISSION_TEXT : state.error ? 'Адреса Webfleet не обновились: повтор позже.' : null };
  });

  app.post('/integrations/webfleet/address-book/sync', { preHandler: requireDispatcherRoles('admin'), config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request) => {
    const result = await sync.runNow(new Date(), actorOf(request));
    if (!result) throw Object.assign(new Error('Адреса уже обновляются. Подождите минуту.'), { statusCode: 409 });
    if (result.error) throw Object.assign(new Error(result.error === 'PERMISSION' ? PERMISSION_TEXT : 'Webfleet не отдал адреса. Повторите позже.'), { statusCode: 502 });
    return sync.state();
  });
}
