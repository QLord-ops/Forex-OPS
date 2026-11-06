import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditActor } from '../services/audit-log.js';
import { requireDispatcherRoles } from '../services/dispatcher-auth.js';
import type { ImportLearningService } from '../services/import-learning.js';
import { BUILT_IN_IMPORT_RULES } from '../services/pdf-order-import.js';

const idParams = z.object({ id: z.string().trim().min(1).max(64) });

function actorOf(request: FastifyRequest): AuditActor | undefined {
  const session = request.dispatcherSession;
  return session ? { role: session.role, sessionId: session.sessionId, dispatcherId: session.dispatcherId } : undefined;
}

/** Rules the import learned from the dispatchers' corrections, like the address rules: both roles may switch them. */
export function registerImportRuleRoutes(app: FastifyInstance, learning: ImportLearningService) {
  const roles = requireDispatcherRoles('admin', 'dispatcher');

  app.get('/import-rules', { preHandler: roles }, async () => {
    const builtIn = [
      ...Object.entries(BUILT_IN_IMPORT_RULES.aliases).map(([pattern, value]) => ({ kind: 'ALIAS', pattern, value })),
      ...Object.entries(BUILT_IN_IMPORT_RULES.ignoreLabels).map(([pattern, value]) => ({ kind: 'IGNORE_LABEL', pattern, value }))
    ];
    return { rules: await learning.list(), builtIn, corrections: { last7d: await learning.correctionsSince(new Date(Date.now() - 7 * 24 * 3600_000)) } };
  });

  app.patch('/import-rules/:id', { preHandler: roles }, async (request) => {
    const { id } = idParams.parse(request.params);
    const patch = z.object({ active: z.boolean().optional(), value: z.string().trim().min(1).max(200).nullable().optional() }).parse(request.body);
    return learning.update(id, patch, actorOf(request));
  });

  app.delete('/import-rules/:id', { preHandler: roles }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await learning.remove(id, actorOf(request));
    return reply.status(204).send();
  });
}
