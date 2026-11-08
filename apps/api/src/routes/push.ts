import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditActor } from '../services/audit-log.js';
import { requireDispatcherRoles } from '../services/dispatcher-auth.js';
import type { PushService } from '../services/push.js';

function actorOf(request: FastifyRequest): AuditActor | undefined {
  const session = request.dispatcherSession;
  return session ? { role: session.role, sessionId: session.sessionId, dispatcherId: session.dispatcherId } : undefined;
}

const base64url = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9_-]+={0,2}$/);
const endpoint = z.string().trim().url().max(2000).refine((value) => value.startsWith('https://'), 'Push-адрес должен быть https.');
const workHours = z.object({
  days: z.array(z.number().int().min(0).max(6)).max(7),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
}).refine((hours) => hours.start < hours.end, 'Начало рабочего дня раньше конца.');

/** Push notifications to the phone of the signed-in dispatcher; both roles may switch it on for their own device. */
export function registerPushRoutes(app: FastifyInstance, push: PushService) {
  const roles = requireDispatcherRoles('admin', 'dispatcher');

  app.get('/push/config', { preHandler: roles }, async () => push.config());

  app.post('/push/subscribe', { preHandler: roles, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!push.config().enabled) return reply.status(503).send({ error: 'Push-уведомления на сервере ещё не настроены.' });
    const input = z.object({ endpoint, keys: z.object({ p256dh: base64url, auth: base64url }), workHours: workHours.nullable().optional() }).parse(request.body);
    return push.subscribe(input, actorOf(request));
  });

  app.post('/push/unsubscribe', { preHandler: roles, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const input = z.object({ endpoint }).parse(request.body);
    return push.unsubscribe(input.endpoint, actorOf(request));
  });
}
