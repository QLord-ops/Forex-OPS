import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashDispatcherPassword, LOGIN_PATTERN, MIN_PASSWORD_LENGTH, requireDispatcherRoles, verifyDispatcherPassword } from '../services/dispatcher-auth.js';
import { writeAuditLog } from '../services/audit-log.js';

const publicFields = { id: true, login: true, displayName: true, role: true, active: true, lastLoginAt: true, onboardingCompletedAt: true, createdAt: true } as const;
const password = z.string().min(MIN_PASSWORD_LENGTH, `Пароль — не меньше ${MIN_PASSWORD_LENGTH} символов.`).max(1024);
const displayName = z.string().trim().min(2).max(80);
const role = z.enum(['admin', 'dispatcher']);
const idParams = z.object({ id: z.string().trim().min(1).max(64) }).strict();

function actor(request: FastifyRequest) {
  const session = request.dispatcherSession;
  return session ? { role: session.role, sessionId: session.sessionId, dispatcherId: session.dispatcherId } : undefined;
}

function badRequest(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Personal dispatcher accounts. Only admins manage them; passwords are never returned or logged.
 * Accounts are deactivated, not deleted, so the audit history keeps its names.
 */
export function registerDispatcherRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const admin = { preHandler: requireDispatcherRoles('admin') };

  app.get('/dispatchers', admin, async () => prisma.dispatcher.findMany({
    select: { ...publicFields, lines: { select: { lineId: true, isPrimary: true } } }, orderBy: [{ active: 'desc' }, { displayName: 'asc' }]
  }));

  /** Colleagues a truck can be handed over to; names only. */
  app.get('/dispatchers/directory', async () => prisma.dispatcher.findMany({ where: { active: true }, select: { id: true, displayName: true }, orderBy: { displayName: 'asc' } }));

  app.post('/dispatchers', admin, async (request, reply) => {
    const body = z.object({
      login: z.string().trim().toLowerCase().regex(LOGIN_PATTERN, 'Логин: 3–40 символов, латиница, цифры, точка, дефис или подчёркивание.'),
      displayName, role, password
    }).strict().parse(request.body);
    if (await prisma.dispatcher.findUnique({ where: { login: body.login } })) throw badRequest('Такой логин уже есть.', 409);
    const created = await prisma.dispatcher.create({
      data: { login: body.login, displayName: body.displayName, role: body.role, passwordHash: hashDispatcherPassword(body.password) },
      select: publicFields
    });
    await writeAuditLog(prisma, actor(request), { action: 'DISPATCHER_CREATED', entityType: 'Dispatcher', entityId: created.id, metadata: { login: created.login, role: created.role } });
    return reply.code(201).send(created);
  });

  app.patch('/dispatchers/:id', admin, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ displayName: displayName.optional(), role: role.optional(), active: z.boolean().optional() }).strict().parse(request.body);
    // An admin cannot lock themselves out by accident.
    if (id === request.dispatcherSession?.dispatcherId && (body.active === false || body.role === 'dispatcher')) throw badRequest('Свой аккаунт нельзя отключить или лишить прав администратора.');
    const existing = await prisma.dispatcher.findUnique({ where: { id }, select: publicFields });
    if (!existing) throw badRequest('Диспетчер не найден.', 404);
    const updated = await prisma.dispatcher.update({ where: { id }, data: body, select: publicFields });
    await writeAuditLog(prisma, actor(request), {
      action: body.active === false ? 'DISPATCHER_DEACTIVATED' : body.active === true && !existing.active ? 'DISPATCHER_REACTIVATED' : 'DISPATCHER_UPDATED',
      entityType: 'Dispatcher', entityId: id, metadata: { changed: Object.keys(body) }
    });
    return updated;
  });

  app.post('/dispatchers/:id/password', admin, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ password }).strict().parse(request.body);
    if (!await prisma.dispatcher.findUnique({ where: { id }, select: { id: true } })) throw badRequest('Диспетчер не найден.', 404);
    await prisma.dispatcher.update({ where: { id }, data: { passwordHash: hashDispatcherPassword(body.password) } });
    await writeAuditLog(prisma, actor(request), { action: 'DISPATCHER_PASSWORD_RESET', entityType: 'Dispatcher', entityId: id });
    return { ok: true };
  });

  /** The guided tour was finished or skipped; a shared login keeps that in the browser instead. */
  app.post('/auth/onboarding', async (request) => {
    const body = z.object({ completed: z.boolean() }).strict().parse(request.body);
    const dispatcherId = request.dispatcherSession?.dispatcherId;
    if (!dispatcherId) return { ok: true, stored: false };
    const completedAt = body.completed ? new Date() : null;
    await prisma.dispatcher.update({ where: { id: dispatcherId }, data: { onboardingCompletedAt: completedAt } });
    await writeAuditLog(prisma, actor(request), { action: body.completed ? 'ONBOARDING_COMPLETED' : 'ONBOARDING_RESET', entityType: 'Dispatcher', entityId: dispatcherId });
    return { ok: true, stored: true, onboardingCompletedAt: completedAt?.toISOString() ?? null };
  });

  app.post('/auth/password', async (request) => {
    const dispatcherId = request.dispatcherSession?.dispatcherId;
    if (!dispatcherId) throw badRequest('Пароль меняется только у личного аккаунта.');
    const body = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: password }).strict().parse(request.body);
    const account = await prisma.dispatcher.findUnique({ where: { id: dispatcherId } });
    if (!account || !verifyDispatcherPassword(body.currentPassword, account.passwordHash)) throw badRequest('Текущий пароль неверный.', 403);
    await prisma.dispatcher.update({ where: { id: dispatcherId }, data: { passwordHash: hashDispatcherPassword(body.newPassword) } });
    await writeAuditLog(prisma, actor(request), { action: 'DISPATCHER_PASSWORD_CHANGED', entityType: 'Dispatcher', entityId: dispatcherId });
    return { ok: true };
  });
}
