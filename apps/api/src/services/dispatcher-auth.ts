import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const COOKIE = 'ops_dispatcher';
const SESSION_MS = 12 * 60 * 60 * 1000;
type QuotaStore = { apiQuota: { upsert(args: { where: { id: string }; create: { id: string; used: number }; update: { used: { increment: number } } }): Promise<{ used: number }> } };
export interface DispatcherAuthOptions {
  disabled?: boolean;
  passwordHash?: string;
  secret?: string;
  origins?: string[];
  now?: () => number;
}

/** Generate offline; store only the returned hash in DISPATCHER_PASSWORD_HASH. */
export function hashDispatcherPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function equal(a: string, b: string): boolean {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export function registerDispatcherAuth(app: FastifyInstance, prisma: QuotaStore, options: DispatcherAuthOptions = {}): void {
  if (options.disabled && process.env.NODE_ENV === 'production') throw new Error('Dispatcher auth cannot be disabled in production');
  const hash = options.passwordHash ?? process.env.DISPATCHER_PASSWORD_HASH ?? '';
  const secret = options.secret ?? process.env.SESSION_SECRET ?? '';
  const configured = /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash) && secret.length >= 32;
  const origins = new Set(options.origins ?? (process.env.DISPATCHER_ALLOWED_ORIGINS ?? 'https://ops-disponent-web.vercel.app,http://localhost:5173,http://127.0.0.1:5173').split(',').map(value => value.trim()).filter(Boolean));
  const now = options.now ?? Date.now;
  const sign = (value: string) => createHmac('sha256', secret).update(`${hash}:${value}`).digest('base64url');
  const csrf = (token: string) => sign(`csrf:${token}`);
  const session = (request: FastifyRequest): { token: string; expiresAt: number } | null => {
    const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || token.length > 500) return null;
    const [expires, nonce, signature, extra] = token.split('.');
    const expiresAt = Number(expires);
    if (extra || !nonce || !signature || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + SESSION_MS || !equal(signature, sign(`${expires}.${nonce}`))) return null;
    return { token, expiresAt };
  };
  const cookie = (token: string, maxAge: number) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : ''}`;

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path === '/health' || options.disabled) return;
    if (!configured) return reply.code(503).send({ error: 'Вход диспетчерской ещё не настроен.' });
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation && (!request.headers.origin || !origins.has(request.headers.origin))) return reply.code(403).send({ error: 'Недопустимый источник запроса.' });
    if (path === '/auth/login' || path === '/auth/session') return;
    const current = session(request);
    if (!current) return reply.code(401).send({ error: 'Войдите в диспетчерскую.' });
    if (mutation && !equal(String(request.headers['x-csrf-token'] ?? ''), csrf(current.token))) return reply.code(403).send({ error: 'Обновите страницу перед выполнением действия.' });
  });

  app.get('/auth/session', async (request, reply) => {
    if (options.disabled) return { authenticated: true, csrfToken: '', expiresAt: null };
    const current = session(request);
    reply.header('Cache-Control', 'no-store');
    return current ? { authenticated: true, csrfToken: csrf(current.token), expiresAt: new Date(current.expiresAt).toISOString() } : { authenticated: false };
  });
  app.post('/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const bucket = Math.floor(now() / (15 * 60_000));
    const ip = createHash('sha256').update(request.ip).digest('hex').slice(0, 24);
    for (const [key, limit] of [[`ip:${ip}`, 10], ['global', 30]] as const) {
      const id = `auth:${bucket}:${key}`;
      const quota = await prisma.apiQuota.upsert({ where: { id }, create: { id, used: 1 }, update: { used: { increment: 1 } } });
      if (quota.used > limit) return reply.header('Retry-After', String(Math.ceil((900_000 - now() % 900_000) / 1000))).code(429).send({ error: 'Слишком много попыток. Попробуйте позднее.' });
    }
    const password = (request.body as { password?: unknown } | null)?.password;
    const [, salt, expected] = hash.split(':');
    if (typeof password !== 'string' || password.length > 1024 || !salt || !expected || !equal(scryptSync(password, salt, 64).toString('hex'), expected)) return reply.code(401).send({ error: 'Неверный пароль.' });
    const expiresAt = now() + SESSION_MS;
    const payload = `${expiresAt}.${randomBytes(24).toString('base64url')}`;
    const token = `${payload}.${sign(payload)}`;
    reply.header('Set-Cookie', cookie(token, SESSION_MS / 1000));
    return { authenticated: true, csrfToken: csrf(token), expiresAt: new Date(expiresAt).toISOString() };
  });
  app.post('/auth/logout', async (_request, reply) => {
    reply.header('Set-Cookie', cookie('', 0)).header('Cache-Control', 'no-store');
    return { authenticated: false };
  });
}
