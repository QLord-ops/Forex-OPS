import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditActor } from '../services/audit-log.js';
import { requireDispatcherRoles } from '../services/dispatcher-auth.js';
import { activeDriverShift, DEFAULT_SHIFT_HOURS, endDriverShift, issueDriverShift, MAX_SHIFT_HOURS, shiftView } from '../services/driver-auth.js';

const idParams = z.object({ id: z.string().trim().min(1).max(64) }).strict();

function actor(request: FastifyRequest): AuditActor {
  const session = request.dispatcherSession!;
  return { role: session.role, sessionId: session.sessionId, dispatcherId: session.dispatcherId };
}

/**
 * The dispatcher's side of the driver app: a shift code for one truck. The code is returned once, when it is
 * issued; afterwards only the state of the shift can be read.
 */
export function registerDriverShiftRoutes(app: FastifyInstance, prisma: PrismaClient, now: () => Date = () => new Date()) {
  const dispatchers = { preHandler: requireDispatcherRoles('admin', 'dispatcher') };

  app.get('/vehicles/:id/driver-shift', dispatchers, async request => {
    const { id } = idParams.parse(request.params);
    const shift = await activeDriverShift(prisma, id, now());
    return { shift: shift ? shiftView(shift) : null };
  });

  app.post('/vehicles/:id/driver-shift', { ...dispatchers, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ hours: z.number().int().min(1).max(MAX_SHIFT_HOURS).default(DEFAULT_SHIFT_HOURS) }).strict().parse(request.body ?? {});
    const { code, shift } = await issueDriverShift(prisma, id, body.hours, actor(request), now());
    reply.header('Cache-Control', 'no-store').code(201);
    return { code, shift: shiftView(shift) };
  });

  app.delete('/vehicles/:id/driver-shift', dispatchers, async request => {
    const { id } = idParams.parse(request.params);
    return { ended: await endDriverShift(prisma, id, actor(request), now()) > 0 };
  });
}
