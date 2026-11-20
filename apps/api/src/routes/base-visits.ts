import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditActor } from '../services/audit-log.js';
import { BASE_RADIUS_METERS, isWeekKey, parseTruckNumbers, weekKeyOf, type BaseVisits } from '../services/base-visits.js';
import { requireDispatcherRoles } from '../services/dispatcher-auth.js';

const idParams = z.object({ id: z.string().trim().min(1).max(64) }).strict();
const weekParams = z.object({ week: z.string().trim().refine(isWeekKey, 'Неделя начинается с понедельника.') }).strict();
const placeSchema = z.object({
  address: z.string().trim().min(5).max(200),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(100).max(3000).default(BASE_RADIUS_METERS)
}).strict();
const weekSchema = z.object({
  /** The list as the owner sends it: «125, 997, 430». */
  trucks: z.string().max(2000),
  dueAt: z.string().datetime().nullable().optional()
}).strict();

function actor(request: FastifyRequest): AuditActor {
  const session = request.dispatcherSession!;
  return { role: session.role, sessionId: session.sessionId, dispatcherId: session.dispatcherId };
}

/** The base and the trucks that come home to it week by week. The list is the admin's; the arrival any dispatcher may record. */
export function registerBaseVisitRoutes(app: FastifyInstance, visits: BaseVisits, now: () => Date = () => new Date()) {
  const dispatchers = { preHandler: requireDispatcherRoles('admin', 'dispatcher') };
  const admins = { preHandler: requireDispatcherRoles('admin') };

  app.get('/base', dispatchers, async (request) => {
    const { week } = z.object({ week: z.string().trim().refine(isWeekKey).optional() }).strict().parse(request.query);
    return { place: await visits.base(), week: await visits.week(week ?? weekKeyOf(now())) };
  });

  app.put('/base', admins, async (request) => visits.setBase(placeSchema.parse(request.body), actor(request)));

  app.put('/base/weeks/:week', admins, async (request) => {
    const { week } = weekParams.parse(request.params);
    const body = weekSchema.parse(request.body);
    return visits.setWeek(week, parseTruckNumbers(body.trucks), body.dueAt ? new Date(body.dueAt) : null, actor(request));
  });

  app.post('/base/visits/:id/arrived', dispatchers, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ at: z.string().datetime().optional() }).strict().parse(request.body ?? {});
    return visits.markArrived(id, body.at ? new Date(body.at) : now(), actor(request), now());
  });

  app.post('/base/visits/:id/arrived/revert', dispatchers, async (request) => {
    const { id } = idParams.parse(request.params);
    return visits.revertArrival(id, actor(request));
  });
}
