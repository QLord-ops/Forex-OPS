import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAuditLog } from '../services/audit-log.js';
import { coverResolver } from '../services/covers.js';

const body = z.object({
  action: z.enum(['take', 'release', 'handover', 'reassign']),
  toDispatcherId: z.string().trim().min(1).max(64).nullable().optional(),
  /** Owner the dispatcher saw; the change only applies if nobody changed it meanwhile. */
  expectedDispatcherId: z.string().trim().min(1).max(64).nullable()
}).strict();

function fail(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Which dispatcher looks after a truck. A dispatcher takes a free truck, releases or hands over their own;
 * only an admin changes someone else's. Concurrent clicks: the first wins, the second gets 409.
 */
export function registerVehicleAssignmentRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.post('/vehicles/:id/assignment', async (request) => {
    const { id } = z.object({ id: z.string().trim().min(1).max(64) }).parse(request.params);
    const input = body.parse(request.body);
    const session = request.dispatcherSession;
    if (!session) throw fail('Войдите в диспетчерскую.', 401);
    const me = session.dispatcherId;
    const isAdmin = session.role === 'admin';
    if (!me && input.action !== 'reassign' && !(isAdmin && input.action === 'release')) throw fail('Машины закрепляются за личным аккаунтом. Войдите под своим логином.', 400);

    // While I stand in for a colleague, their trucks are mine to release or hand over.
    const standsIn = async () => {
      if (!me || !input.expectedDispatcherId) return false;
      const vehicle = await prisma.vehicle.findUnique({ where: { id }, select: { customerLineId: true } });
      return (await coverResolver(prisma)).actingFor(input.expectedDispatcherId, vehicle?.customerLineId ?? null) === me;
    };
    let target: string | null;
    if (input.action === 'take') {
      if (input.expectedDispatcherId !== null) throw fail('Машину ведёт другой диспетчер. Забрать её может администратор.', 403);
      target = me;
    } else if (input.action === 'release') {
      if (input.expectedDispatcherId !== me && !isAdmin && !await standsIn()) throw fail('Освободить можно только свою машину.', 403);
      target = null;
    } else if (input.action === 'handover') {
      if (input.expectedDispatcherId !== me && !await standsIn()) throw fail('Передать можно только свою машину.', 403);
      if (!input.toDispatcherId || input.toDispatcherId === me) throw fail('Выберите коллегу.', 400);
      target = input.toDispatcherId;
    } else {
      if (!isAdmin) throw fail('Сменить чужого диспетчера может только администратор.', 403);
      target = input.toDispatcherId ?? null;
    }
    if (target && target !== me) {
      const colleague = await prisma.dispatcher.findUnique({ where: { id: target }, select: { active: true } });
      if (!colleague?.active) throw fail('Этот диспетчер не найден или отключён.', 400);
    }

    const changed = await prisma.vehicle.updateMany({
      where: { id, assignedDispatcherId: input.expectedDispatcherId },
      data: { assignedDispatcherId: target, assignedAt: target ? new Date() : null }
    });
    if (!changed.count) {
      if (!await prisma.vehicle.findUnique({ where: { id }, select: { id: true } })) throw fail('Грузовик не найден.', 404);
      throw fail('Машину только что взял или передал другой диспетчер. Список обновлён — проверьте и повторите.', 409);
    }
    await writeAuditLog(prisma, { role: session.role, sessionId: session.sessionId, dispatcherId: me }, {
      action: 'VEHICLE_ASSIGNMENT_CHANGED', entityType: 'Vehicle', entityId: id, vehicleId: id,
      metadata: { action: input.action, from: input.expectedDispatcherId, to: target }
    });
    const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id }, select: { id: true, assignedDispatcher: { select: { id: true, displayName: true } } } });
    return { vehicleId: id, assignedTo: vehicle.assignedDispatcher ? { id: vehicle.assignedDispatcher.id, name: vehicle.assignedDispatcher.displayName } : null };
  });
}
