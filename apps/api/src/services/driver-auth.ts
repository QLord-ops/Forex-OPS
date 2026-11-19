import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAuditLog, type AuditActor } from './audit-log.js';
import { hashDispatcherPassword, verifyDispatcherPassword } from './dispatcher-auth.js';

const COOKIE = 'ops_driver';
/** Wrong codes in a row before the code locks and the dispatcher has to issue a new one. */
export const SHIFT_CODE_ATTEMPTS = 5;
export const DEFAULT_SHIFT_HOURS = 15;
/** A week: long enough for a tour away from the yard without a new code every morning. */
export const MAX_SHIFT_HOURS = 168;
const LOGIN_FAILURES_PER_IP = 10;
const LOGIN_FAILURES_TOTAL = 200;
/** Same cost as a real check, so an unknown truck takes as long as a wrong code. */
const DUMMY_HASH = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;

/** The driver app's session: one truck for one shift. No person behind it (DSGVO). */
export interface DriverSession {
  token: string;
  sessionId: string;
  shiftId: string;
  vehicleId: string;
  expiresAt: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    driverSession: DriverSession | null;
  }
}

export interface DriverAuthOptions {
  secret?: string;
  origins?: string[];
  now?: () => number;
}

type Database = PrismaClient | Prisma.TransactionClient;

export function driverActor(session: DriverSession): AuditActor {
  return { role: 'driver', sessionId: session.sessionId };
}

/** «GÖ-FX 214», «gö fx214» and «GÖFX214» are the same truck. */
export function normalizeVehicleInput(value: string): string {
  return value.toLocaleUpperCase('de-DE').replace(/[^\p{L}\p{N}]/gu, '');
}

function equal(a: string, b: string): boolean {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

const active = (vehicleId: string, at: Date) => ({ vehicleId, endedAt: null, startsAt: { lte: at }, endsAt: { gt: at } });

export function shiftView(shift: { id: string; startsAt: Date; endsAt: Date; firstUsedAt: Date | null; lastUsedAt: Date | null; failedAttempts: number }) {
  return { id: shift.id, startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(), firstUsedAt: shift.firstUsedAt?.toISOString() ?? null,
    lastUsedAt: shift.lastUsedAt?.toISOString() ?? null, locked: shift.failedAttempts >= SHIFT_CODE_ATTEMPTS };
}

export async function activeDriverShift(db: Database, vehicleId: string, now = new Date()) {
  return db.driverShift.findFirst({ where: active(vehicleId, now), orderBy: { createdAt: 'desc' } });
}

/** A new code replaces the truck's current one: the phone signed in with the old code is signed out. */
export async function issueDriverShift(db: PrismaClient, vehicleId: string, hours: number, actor: AuditActor, now = new Date()) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const endsAt = new Date(now.getTime() + hours * 3_600_000);
  const shift = await db.$transaction(async tx => {
    await tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId }, select: { id: true } });
    const replaced = await tx.driverShift.updateMany({ where: { vehicleId, endedAt: null, endsAt: { gt: now } }, data: { endedAt: now, endedByDispatcherId: actor.dispatcherId ?? null } });
    const created = await tx.driverShift.create({ data: { vehicleId, codeHash: hashDispatcherPassword(code), startsAt: now, endsAt, createdByDispatcherId: actor.dispatcherId ?? null, createdAt: now } });
    await writeAuditLog(tx, actor, { action: 'DRIVER_SHIFT_ISSUED', entityType: 'DriverShift', entityId: created.id, vehicleId,
      metadata: { endsAt: endsAt.toISOString(), hours, replaced: replaced.count }, createdAt: now });
    return created;
  });
  return { code, shift };
}

export async function endDriverShift(db: PrismaClient, vehicleId: string, actor: AuditActor, now = new Date()): Promise<number> {
  return db.$transaction(async tx => {
    const ended = await tx.driverShift.updateMany({ where: { vehicleId, endedAt: null, endsAt: { gt: now } }, data: { endedAt: now, endedByDispatcherId: actor.dispatcherId ?? null } });
    if (ended.count) await writeAuditLog(tx, actor, { action: 'DRIVER_SHIFT_ENDED', entityType: 'Vehicle', entityId: vehicleId, vehicleId, metadata: { ended: ended.count }, createdAt: now });
    return ended.count;
  });
}

/**
 * Sign-in of the driver app and the gate in front of every `/driver/*` route. The returned gate is called by the
 * dispatcher auth hook: a dispatcher cookie opens nothing under `/driver`, and a driver cookie opens nothing else.
 */
export function registerDriverAuth(app: FastifyInstance, prisma: PrismaClient, options: DriverAuthOptions = {}) {
  const secret = options.secret ?? process.env.SESSION_SECRET ?? '';
  const configured = secret.length >= 32;
  const origins = new Set(options.origins ?? driverOrigins());
  const now = options.now ?? Date.now;
  const sign = (value: string) => createHmac('sha256', secret).update(`driver:${value}`).digest('base64url');
  const csrf = (token: string) => sign(`csrf:${token}`);
  const cookie = (token: string, maxAge: number) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : ''}`;

  const parse = (request: FastifyRequest): DriverSession | null => {
    const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || token.length > 300) return null;
    const parts = token.split('.');
    if (parts.length !== 5) return null;
    const [expires, shiftId, vehicleId, nonce, signature] = parts;
    const expiresAt = Number(expires);
    const id = /^[A-Za-z0-9_-]{1,64}$/;
    if (!id.test(shiftId) || !id.test(vehicleId) || !nonce || !Number.isSafeInteger(expiresAt) || expiresAt <= now()
      || !equal(signature, sign(parts.slice(0, -1).join('.')))) return null;
    return { token, expiresAt, shiftId, vehicleId, sessionId: createHash('sha256').update(token).digest('hex').slice(0, 32) };
  };
  /** A valid signature is not enough: the shift must still run, so a new code or «Завершить смену» signs the phone out at once. */
  const resolve = async (found: DriverSession | null) => {
    if (!found) return null;
    if (await prisma.apiQuota.findUnique({ where: { id: `revoked:${found.sessionId}` } })) return null;
    const shift = await prisma.driverShift.findUnique({ where: { id: found.shiftId } });
    if (!shift || shift.vehicleId !== found.vehicleId || shift.endedAt || shift.endsAt.getTime() <= now()) return null;
    return found;
  };
  const vehicleOf = async (vehicleId: string) => prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true, vehicleNumber: true, licensePlate: true } });

  app.decorateRequest('driverSession', null);

  const gate = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!configured) return reply.code(503).send({ error: 'Вход для водителей ещё не настроен.' });
    const path = request.url.split('?')[0];
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation && (!request.headers.origin || !origins.has(request.headers.origin))) return reply.code(403).send({ error: 'Недопустимый источник запроса.' });
    if (path === '/driver/auth/login' || path === '/driver/auth/session') return;
    const current = await resolve(parse(request));
    if (!current) return reply.code(401).send({ error: 'Войдите по коду смены.' });
    request.driverSession = current;
    if (mutation && !equal(String(request.headers['x-csrf-token'] ?? ''), csrf(current.token))) return reply.code(403).send({ error: 'Обновите страницу перед выполнением действия.' });
  };

  app.get('/driver/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const current = await resolve(parse(request));
    const vehicle = current ? await vehicleOf(current.vehicleId) : null;
    return current && vehicle
      ? { authenticated: true, csrfToken: csrf(current.token), expiresAt: new Date(current.expiresAt).toISOString(), vehicle: { vehicleNumber: vehicle.vehicleNumber, licensePlate: vehicle.licensePlate } }
      : { authenticated: false };
  });

  app.post('/driver/auth/login', { bodyLimit: 1024, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const at = now();
    const bucket = Math.floor(at / (15 * 60_000));
    const ip = createHash('sha256').update(request.ip).digest('hex').slice(0, 24);
    // Only wrong codes count, so drivers behind one mobile gateway are not locked out by normal sign-ins.
    const failureKeys: Array<readonly [string, number]> = [[`driver-auth:${bucket}:ip:${ip}`, LOGIN_FAILURES_PER_IP], [`driver-auth:${bucket}:global`, LOGIN_FAILURES_TOTAL]];
    for (const [id, limit] of failureKeys) {
      const quota = await prisma.apiQuota.findUnique({ where: { id } });
      if ((quota?.used ?? 0) >= limit) return reply.header('Retry-After', String(Math.ceil((900_000 - at % 900_000) / 1000))).code(429).send({ error: 'Слишком много попыток. Попробуйте позднее.' });
    }
    const parsed = z.object({ vehicle: z.string().trim().min(1).max(20), code: z.string().trim().regex(/^\d{6}$/) }).strict().safeParse(request.body);
    const wanted = parsed.success ? normalizeVehicleInput(parsed.data.vehicle) : '';
    const vehicle = wanted
      ? (await prisma.vehicle.findMany({ select: { id: true, vehicleNumber: true, licensePlate: true } }))
        .find(item => normalizeVehicleInput(item.vehicleNumber) === wanted || (item.licensePlate !== null && normalizeVehicleInput(item.licensePlate) === wanted)) ?? null
      : null;
    const shift = vehicle ? await activeDriverShift(prisma, vehicle.id, new Date(at)) : null;
    // The attempt is taken before the code is checked: parallel guesses cannot get more tries than the limit.
    const reserved = shift ? (await prisma.driverShift.updateMany({ where: { id: shift.id, endedAt: null, failedAttempts: { lt: SHIFT_CODE_ATTEMPTS } }, data: { failedAttempts: { increment: 1 } } })).count === 1 : false;
    if (shift && !reserved) return reply.code(423).send({ error: 'Код заблокирован после неверных попыток. Новый код — у диспетчера.' });
    const matches = verifyDispatcherPassword(parsed.success ? parsed.data.code : '', shift?.codeHash ?? DUMMY_HASH);
    if (!vehicle || !shift || !matches) {
      for (const [id] of failureKeys) await prisma.apiQuota.upsert({ where: { id }, create: { id, used: 1 }, update: { used: { increment: 1 } } });
      if (shift && shift.failedAttempts + 1 >= SHIFT_CODE_ATTEMPTS) {
        await writeAuditLog(prisma, { role: 'system', sessionId: 'driver-auth' }, { action: 'DRIVER_SHIFT_LOCKED', entityType: 'DriverShift', entityId: shift.id, vehicleId: shift.vehicleId, createdAt: new Date(at) });
      }
      return reply.code(401).send({ error: 'Неверный номер машины или код.' });
    }
    const expiresAt = shift.endsAt.getTime();
    const payload = `${expiresAt}.${shift.id}.${vehicle.id}.${randomBytes(24).toString('base64url')}`;
    const token = `${payload}.${sign(payload)}`;
    const session: DriverSession = { token, expiresAt, shiftId: shift.id, vehicleId: vehicle.id, sessionId: createHash('sha256').update(token).digest('hex').slice(0, 32) };
    await prisma.driverShift.update({ where: { id: shift.id }, data: { failedAttempts: 0, firstUsedAt: shift.firstUsedAt ?? new Date(at), lastUsedAt: new Date(at) } });
    await writeAuditLog(prisma, driverActor(session), { action: 'DRIVER_LOGIN', entityType: 'DriverShift', entityId: shift.id, vehicleId: vehicle.id, createdAt: new Date(at) });
    reply.header('Set-Cookie', cookie(token, Math.max(1, Math.floor((expiresAt - at) / 1000))));
    return { authenticated: true, csrfToken: csrf(token), expiresAt: new Date(expiresAt).toISOString(), vehicle: { vehicleNumber: vehicle.vehicleNumber, licensePlate: vehicle.licensePlate } };
  });

  app.post('/driver/auth/logout', async (request, reply) => {
    const session = request.driverSession;
    if (session) {
      const id = `revoked:${session.sessionId}`;
      await prisma.apiQuota.upsert({ where: { id }, create: { id, used: 1 }, update: { used: { increment: 0 } } });
      await writeAuditLog(prisma, driverActor(session), { action: 'DRIVER_LOGOUT', entityType: 'DriverShift', entityId: session.shiftId, vehicleId: session.vehicleId, createdAt: new Date(now()) });
    }
    reply.header('Set-Cookie', cookie('', 0)).header('Cache-Control', 'no-store');
    return { authenticated: false };
  });

  return gate;
}

export function driverOrigins(value = process.env.DRIVER_ALLOWED_ORIGINS): string[] {
  return (value ?? 'http://localhost:5174,http://127.0.0.1:5174').split(',').map(item => item.trim()).filter(Boolean);
}
