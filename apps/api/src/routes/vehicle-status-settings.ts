import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAuditLog, type AuditActor } from '../services/audit-log.js';
import { requireDispatcherRoles } from '../services/dispatcher-auth.js';

export const VEHICLE_LINES = ['SCHNELLECKE', 'WALTER_TESLA', 'OTHER'] as const;
export const STATUS_GROUPS = ['NORD', 'SUED', 'LUFE'] as const;
/** Webfleet trucks that do not run on Schnellecke (owner decision 2026-11-05): left unchecked in the first assignment. */
export const SCHNELLECKE_PRESET_EXCLUDED = ['727', '2853'];

const settingsSchema = z.object({
  line: z.enum(VEHICLE_LINES).nullable().optional(),
  statusGroup: z.enum(STATUS_GROUPS).nullable().optional(),
  servicePhone: z.string().trim().regex(/^[+0-9 ()/-]{5,30}$/, 'Номер: только цифры, пробелы и + ( ) / -').nullable().optional(),
  aSchild: z.boolean().optional(),
  appSped: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'Нет изменений.' });
const bulkSchema = z.object({
  line: z.enum(VEHICLE_LINES),
  vehicleIds: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
  /** Off by default: a line a dispatcher already chose stays as it is. */
  overwrite: z.boolean().default(false)
}).strict();

function fail(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}
function actorOf(request: FastifyRequest): AuditActor {
  const session = request.dispatcherSession;
  if (!session) throw fail('Войдите в диспетчерскую.', 401);
  return { role: session.role, sessionId: session.sessionId, dispatcherId: session.dispatcherId };
}

/** Line, status block, service phone and the A Schild / AppSped flags of a truck: what the 07:00 status list needs. */
export function registerVehicleStatusSettingsRoutes(app: FastifyInstance, prisma: PrismaClient) {
  app.patch('/vehicles/:id/status-settings', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async (request) => {
    const { id } = z.object({ id: z.string().trim().min(1).max(64) }).parse(request.params);
    const input = settingsSchema.parse(request.body);
    const actor = actorOf(request);
    if (!await prisma.vehicle.findUnique({ where: { id }, select: { id: true } })) throw fail('Грузовик не найден.', 404);
    // Not an operation on the trip: operationVersion stays, so a settings change never conflicts with BELADEN or a reroute.
    const vehicle = await prisma.vehicle.update({ where: { id }, data: input,
      select: { id: true, vehicleNumber: true, line: true, statusGroup: true, servicePhone: true, aSchild: true, appSped: true } });
    const { servicePhone, ...visible } = input;
    await writeAuditLog(prisma, actor, { action: 'VEHICLE_STATUS_SETTINGS_UPDATED', entityType: 'Vehicle', entityId: id, vehicleId: id,
      // The phone number itself never goes into the log.
      metadata: { ...visible, ...(servicePhone !== undefined ? { servicePhoneChanged: true } : {}) } });
    return vehicle;
  });

  app.get('/vehicles/status-settings/preset', { preHandler: requireDispatcherRoles('admin') }, async (request) => {
    const { line } = z.object({ line: z.enum(VEHICLE_LINES).default('SCHNELLECKE') }).parse(request.query);
    const vehicles = await prisma.vehicle.findMany({
      where: { integrations: { some: { provider: 'WEBFLEET', status: 'ACTIVE' } } },
      select: { id: true, vehicleNumber: true, line: true }, orderBy: { vehicleNumber: 'asc' }
    });
    return { line, candidates: vehicles.map((vehicle) => ({
      id: vehicle.id, vehicleNumber: vehicle.vehicleNumber, currentLine: vehicle.line,
      defaultSelected: vehicle.line === null && !(line === 'SCHNELLECKE' && SCHNELLECKE_PRESET_EXCLUDED.includes(vehicle.vehicleNumber))
    })) };
  });

  app.post('/vehicles/status-settings/bulk', { preHandler: requireDispatcherRoles('admin') }, async (request) => {
    const input = bulkSchema.parse(request.body);
    const actor = actorOf(request);
    const ids = [...new Set(input.vehicleIds)];
    const targets = await prisma.vehicle.findMany({ where: { id: { in: ids }, ...(input.overwrite ? {} : { line: null }) }, select: { id: true, vehicleNumber: true } });
    const changed = await prisma.vehicle.updateMany({ where: { id: { in: targets.map((vehicle) => vehicle.id) } }, data: { line: input.line } });
    await writeAuditLog(prisma, actor, { action: 'VEHICLE_LINE_BULK_SET', entityType: 'Vehicle', entityId: 'bulk',
      metadata: { line: input.line, overwrite: input.overwrite, vehicles: targets.map((vehicle) => vehicle.vehicleNumber), skipped: ids.length - targets.length } });
    return { changed: changed.count, skipped: ids.length - targets.length };
  });
}
