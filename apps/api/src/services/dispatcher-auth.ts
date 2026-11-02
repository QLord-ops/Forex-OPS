import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const COOKIE = 'ops_dispatcher';
const SESSION_MS = 12 * 60 * 60 * 1000;
export type DispatcherRole = 'admin' | 'dispatcher';
export interface DispatcherSession {
  token: string;
  expiresAt: number;
  role: DispatcherRole;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    dispatcherSession: DispatcherSession | null;
  }
}

type QuotaStore = { apiQuota: {
  upsert(args: { where: { id: string }; create: { id: string; used: number }; update: { used: { increment: number } } }): Promise<{ used: number }>;
  findUnique(args: { where: { id: string } }): Promise<{ used: number } | null>;
} };
const LOGIN_FAILURES_PER_IP = 10;
const LOGIN_FAILURES_TOTAL = 100;
const REVOCATION_RECHECK_MS = 60_000;
export interface DispatcherAuthOptions {
  disabled?: boolean;
  /** @deprecated Use dispatcherPasswordHash. */
  passwordHash?: string;
  dispatcherPasswordHash?: string;
  adminPasswordHash?: string;
  secret?: string;
  origins?: string[];
  now?: () => number;
}

/** Generate offline; store only the returned hash in DISPATCHER_PASSWORD_HASH. */
export function hashDispatcherPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function requireDispatcherRoles(...roles: DispatcherRole[]) {
  const allowed = new Set(roles);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const role = request.dispatcherSession?.role;
    if (!role) return reply.code(401).send({ error: 'Войдите в диспетчерскую.' });
    if (!allowed.has(role)) return reply.code(403).send({ error: 'Недостаточно прав для этого действия.' });
  };
}

function equal(a: string, b: string): boolean {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export function registerDispatcherAuth(app: FastifyInstance, prisma: QuotaStore, options: DispatcherAuthOptions = {}): void {
  if (options.disabled && process.env.NODE_ENV === 'production') throw new Error('Dispatcher auth cannot be disabled in production');
  const dispatcherHash = options.dispatcherPasswordHash ?? options.passwordHash ?? process.env.DISPATCHER_PASSWORD_HASH ?? '';
  const adminHash = options.adminPasswordHash ?? process.env.ADMIN_PASSWORD_HASH ?? '';
  const secret = options.secret ?? process.env.SESSION_SECRET ?? '';
  const hashPattern = /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/;
  const configured = (hashPattern.test(dispatcherHash) || hashPattern.test(adminHash)) && secret.length >= 32;
  const origins = new Set(options.origins ?? (process.env.DISPATCHER_ALLOWED_ORIGINS ?? 'https://ops-disponent-web.vercel.app,http://localhost:5173,http://127.0.0.1:5173').split(',').map(value => value.trim()).filter(Boolean));
  const now = options.now ?? Date.now;
  const sign = (value: string) => createHmac('sha256', secret).update(`${adminHash}:${dispatcherHash}:${value}`).digest('base64url');
  const csrf = (token: string) => sign(`csrf:${token}`);
  const session = (request: FastifyRequest): DispatcherSession | null => {
    const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || token.length > 500) return null;
    const [expires, role, nonce, signature, extra] = token.split('.');
    const expiresAt = Number(expires);
    if (extra || (role !== 'admin' && role !== 'dispatcher') || !nonce || !signature || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + SESSION_MS || !equal(signature, sign(`${expires}.${role}.${nonce}`))) return null;
    return { token, expiresAt, role, sessionId: createHash('sha256').update(token).digest('hex').slice(0, 32) };
  };
  const cookie = (token: string, maxAge: number) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : ''}`;

  // Logout revokes the signed token server-side; other instances notice within a minute.
  const revoked = new Set<string>();
  const checked = new Map<string, number>();
  const isRevoked = async (sessionId: string) => {
    if (revoked.has(sessionId)) return true;
    const last = checked.get(sessionId);
    if (last !== undefined && now() - last < REVOCATION_RECHECK_MS) return false;
    const row = await prisma.apiQuota.findUnique({ where: { id: `revoked:${sessionId}` } });
    if (row) { revoked.add(sessionId); return true; }
    if (checked.size > 5000) checked.clear();
    checked.set(sessionId, now());
    return false;
  };

  app.decorateRequest('dispatcherSession', null);

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (options.disabled) {
      request.dispatcherSession = { token: 'disabled', expiresAt: Number.MAX_SAFE_INTEGER, role: 'admin', sessionId: 'disabled-test-session' };
      return;
    }
    if (path === '/health') return;
    if (!configured) return reply.code(503).send({ error: 'Вход диспетчерской ещё не настроен.' });
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation && (!request.headers.origin || !origins.has(request.headers.origin))) return reply.code(403).send({ error: 'Недопустимый источник запроса.' });
    if (path === '/auth/login' || path === '/auth/session') return;
    const current = session(request);
    if (!current || await isRevoked(current.sessionId)) return reply.code(401).send({ error: 'Войдите в диспетчерскую.' });
    request.dispatcherSession = current;
    if (mutation && !equal(String(request.headers['x-csrf-token'] ?? ''), csrf(current.token))) return reply.code(403).send({ error: 'Обновите страницу перед выполнением действия.' });
  });

  app.get('/auth/session', async (request, reply) => {
    if (options.disabled) return { authenticated: true, role: 'admin' as const, csrfToken: '', expiresAt: null };
    const found = session(request);
    const current = found && !await isRevoked(found.sessionId) ? found : null;
    reply.header('Cache-Control', 'no-store');
    return current ? { authenticated: true, role: current.role, csrfToken: csrf(current.token), expiresAt: new Date(current.expiresAt).toISOString() } : { authenticated: false };
  });
  app.post('/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const bucket = Math.floor(now() / (15 * 60_000));
    const ip = createHash('sha256').update(request.ip).digest('hex').slice(0, 24);
    // Only wrong passwords count, so colleagues behind one office IP are not locked out by normal logins.
    const failureKeys = [[`auth:${bucket}:ip:${ip}`, LOGIN_FAILURES_PER_IP], [`auth:${bucket}:global`, LOGIN_FAILURES_TOTAL]] as const;
    for (const [id, limit] of failureKeys) {
      const quota = await prisma.apiQuota.findUnique({ where: { id } });
      if ((quota?.used ?? 0) >= limit) return reply.header('Retry-After', String(Math.ceil((900_000 - now() % 900_000) / 1000))).code(429).send({ error: 'Слишком много попыток. Попробуйте позднее.' });
    }
    const parsed = z.object({ password: z.string().min(1).max(1024) }).strict().safeParse(request.body);
    const password = parsed.success ? parsed.data.password : null;
    const verify = (hash: string) => {
      const [, salt, expected] = hash.split(':');
      return Boolean(salt && expected && typeof password === 'string' && password.length <= 1024 && equal(scryptSync(password, salt, 64).toString('hex'), expected));
    };
    const adminMatches = hashPattern.test(adminHash) && verify(adminHash);
    const dispatcherMatches = hashPattern.test(dispatcherHash) && verify(dispatcherHash);
    const role: DispatcherRole | null = adminMatches ? 'admin' : dispatcherMatches ? 'dispatcher' : null;
    if (!role) {
      for (const [id] of failureKeys) await prisma.apiQuota.upsert({ where: { id }, create: { id, used: 1 }, update: { used: { increment: 1 } } });
      return reply.code(401).send({ error: 'Неверный пароль.' });
    }
    const expiresAt = now() + SESSION_MS;
    const payload = `${expiresAt}.${role}.${randomBytes(24).toString('base64url')}`;
    const token = `${payload}.${sign(payload)}`;
    reply.header('Set-Cookie', cookie(token, SESSION_MS / 1000));
    return { authenticated: true, role, csrfToken: csrf(token), expiresAt: new Date(expiresAt).toISOString() };
  });
  app.post('/auth/logout', async (request, reply) => {
    const sessionId = request.dispatcherSession?.sessionId;
    if (sessionId && !options.disabled) {
      const id = `revoked:${sessionId}`;
      await prisma.apiQuota.upsert({ where: { id }, create: { id, used: 1 }, update: { used: { increment: 0 } } });
      revoked.add(sessionId);
    }
    reply.header('Set-Cookie', cookie('', 0)).header('Cache-Control', 'no-store');
    return { authenticated: false };
  });
}
