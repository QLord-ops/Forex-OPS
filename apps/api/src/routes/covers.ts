import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditActor } from '../services/audit-log.js';
import { endCover, startCover, teamOverview } from '../services/covers.js';
import { requireDispatcherRoles } from '../services/dispatcher-auth.js';

const id = z.string().trim().min(1).max(64);
const startBody = z.object({
  absentDispatcherId: id,
  coverDispatcherId: id,
  /** null: every line and every truck the absent dispatcher took. */
  lineIds: z.array(id).min(1).max(100).nullable(),
  endsAt: z.string().datetime({ offset: true })
}).strict();

function actorOf(request: FastifyRequest): AuditActor {
  const session = request.dispatcherSession;
  if (!session) throw Object.assign(new Error('Войдите в диспетчерскую.'), { statusCode: 401 });
  return { role: session.role, sessionId: session.sessionId, dispatcherId: session.dispatcherId };
}

/**
 * One dispatcher works for another (holiday, illness, end of shift). A dispatcher gives their own lines away or takes a
 * colleague's; an admin arranges any. The cover ends by itself at its time.
 */
export function registerCoverRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const anyRole = { preHandler: requireDispatcherRoles('admin', 'dispatcher') };

  app.get('/team', anyRole, async (request) => teamOverview(prisma, request.dispatcherSession?.dispatcherId ?? null, new Date()));

  app.post('/covers', anyRole, async (request, reply) => {
    const input = startBody.parse(request.body);
    const cover = await startCover(prisma, { ...input, endsAt: new Date(input.endsAt) }, actorOf(request), new Date());
    return reply.status(201).send({ id: cover.id, endsAt: cover.endsAt.toISOString() });
  });

  app.post('/covers/:id/end', anyRole, async (request) => {
    const params = z.object({ id }).parse(request.params);
    return endCover(prisma, params.id, actorOf(request), new Date());
  });
}
