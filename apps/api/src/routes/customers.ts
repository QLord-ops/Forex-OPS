import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditActor } from '../services/audit-log.js';
import { CUSTOMER_CATEGORIES } from '../services/customer-profile.js';
import { CustomerError, type CustomerService } from '../services/customers.js';
import { requireDispatcherRoles } from '../services/dispatcher-auth.js';

const idParams = z.object({ id: z.string().trim().min(1).max(64) });
const name = z.string().trim().min(2).max(80);
const alias = z.string().trim().min(2).max(120);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет в формате #RRGGBB.').nullable();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const profilePatch = z.object({
  import: z.record(z.unknown()).optional(),
  statusList: z.record(z.unknown()).optional(),
  defaults: z.record(z.unknown()).optional()
}).strict();
const customerCreate = z.object({
  name, slug: z.string().trim().min(2).max(40).optional(), category: z.enum(CUSTOMER_CATEGORIES).optional(),
  aliases: z.array(alias).max(20).optional(), color: color.optional(), profile: profilePatch.optional()
}).strict();
const customerPatch = z.object({
  name: name.optional(), category: z.enum(CUSTOMER_CATEGORIES).optional(), aliases: z.array(alias).max(20).optional(),
  color: color.optional(), active: z.boolean().optional(), profile: profilePatch.optional()
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'Нет изменений.' });
const lineCreate = z.object({
  code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(80),
  departmentCompany: optionalText(200), departmentAddress: optionalText(300), departmentCity: optionalText(120), sortIndex: z.number().int().min(0).max(999).optional()
}).strict();
const linePatch = lineCreate.omit({ code: true }).partial().extend({ active: z.boolean().optional() }).strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Нет изменений.' });

function actorOf(request: FastifyRequest): AuditActor | undefined {
  const session = request.dispatcherSession;
  return session ? { role: session.role, sessionId: session.sessionId, dispatcherId: session.dispatcherId } : undefined;
}
function customerError(error: unknown): never {
  if (error instanceof CustomerError) throw Object.assign(new Error(error.message), { statusCode: error.statusCode });
  throw error;
}

/**
 * Customers and their lines. Admins create customers and lines and give dispatchers their lines; a dispatcher
 * edits the profile of their own customers and puts trucks on lines. Nothing is deleted: customers and lines are archived.
 */
export function registerCustomerRoutes(app: FastifyInstance, customers: CustomerService) {
  const anyRole = { preHandler: requireDispatcherRoles('admin', 'dispatcher') };
  const admin = { preHandler: requireDispatcherRoles('admin') };

  app.get('/customers', anyRole, async () => ({ customers: await customers.list() }));

  app.get('/customers/migration-preview', admin, async () => ({ customers: await customers.migrationPreview() }));

  app.post('/customers/migrate-from-lines', admin, async (request) => ({ result: await customers.migrateFromLines(actorOf(request)).catch(customerError) }));

  app.get('/customers/:id', anyRole, async (request) => customers.get(idParams.parse(request.params).id).catch(customerError));

  app.post('/customers', admin, async (request, reply) => {
    const input = customerCreate.parse(request.body);
    return reply.status(201).send(await customers.create(input, actorOf(request)).catch(customerError));
  });

  app.patch('/customers/:id', anyRole, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = customerPatch.parse(request.body);
    const actor = actorOf(request);
    const onlyProfile = Object.keys(input).every((key) => key === 'profile');
    // A dispatcher may tune the profile of their own customer; everything else about a customer is the admin's.
    if (actor?.role !== 'admin' && (!onlyProfile || !await customers.canEditProfile(actor, id))) {
      throw Object.assign(new Error('Профиль этого заказчика правят администратор и диспетчеры его линий.'), { statusCode: 403 });
    }
    return customers.update(id, input, actor).catch(customerError);
  });

  app.post('/customers/:id/lines', admin, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    return reply.status(201).send(await customers.addLine(id, lineCreate.parse(request.body), actorOf(request)).catch(customerError));
  });

  app.patch('/customer-lines/:id', admin, async (request) => {
    const { id } = idParams.parse(request.params);
    return customers.updateLine(id, linePatch.parse(request.body), actorOf(request)).catch(customerError);
  });

  app.put('/vehicles/:id/customer-line', anyRole, async (request) => {
    const { id } = idParams.parse(request.params);
    const { lineId } = z.object({ lineId: z.string().trim().min(1).max(64).nullable() }).strict().parse(request.body);
    return customers.setVehicleLine(id, lineId, actorOf(request)).catch(customerError);
  });

  app.put('/dispatchers/:id/lines', admin, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = z.object({ lineIds: z.array(z.string().trim().min(1).max(64)).max(50), primaryLineId: z.string().trim().min(1).max(64).nullable().optional() }).strict().parse(request.body);
    return { lines: await customers.setDispatcherLines(id, input.lineIds, input.primaryLineId ?? null, actorOf(request)).catch(customerError) };
  });
}
