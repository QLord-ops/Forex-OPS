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
  /** Personal account; null for the shared-password sessions of the transition period. */
  dispatcherId: string | null;
  displayName: string | null;
}

export type DispatcherAccount = { id: string; login: string; displayName: string; role: string; passwordHash: string; active: boolean };
type AccountStore = {
  findUnique(args: { where: { login: string } | { id: string } }): Promise<DispatcherAccount | null>;
  count(args: { where: { active: boolean } }): Promise<number>;
  update(args: { where: { id: string }; data: { lastLoginAt: Date } }): Promise<unknown>;
};

declare module 'fastify' {
  interface FastifyRequest {
    dispatcherSession: DispatcherSession | null;
  }
}

type QuotaStore = { apiQuota: {
  upsert(args: { where: { id: string }; create: { id: string; used: number }; update: { used: { increment: number } } }): Promise<{ used: number }>;
  findUnique(args: { where: { id: string } }): Promise<{ used: number } | null>;
}; dispatcher?: AccountStore };
const LOGIN_FAILURES_PER_IP = 10;
const LOGIN_FAILURES_PER_LOGIN = 10;
const ACCOUNT_RECHECK_MS = 60_000;
/** Same cost as a real check, so an unknown login takes as long as a wrong password. */
const DUMMY_HASH = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
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

export const LOGIN_PATTERN = /^[a-z0-9._-]{3,40}$/;
export const MIN_PASSWORD_LENGTH = 12;

export function verifyDispatcherPassword(password: string, hash: string): boolean {
  const [, salt, expected] = hash.split(':');
  return Boolean(salt && expected && password.length <= 1024 && equal(scryptSync(password, salt, 64).toString('hex'), expected));
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
  const configured = (hashPattern.test(dispatcherHash) || hashPattern.test(adminHash) || Boolean(prisma.dispatcher)) && secret.length >= 32;
  const origins = new Set(options.origins ?? (process.env.DISPATCHER_ALLOWED_ORIGINS ?? 'https://ops-disponent-web.vercel.app,http://localhost:5173,http://127.0.0.1:5173').split(',').map(value => value.trim()).filter(Boolean));
  const now = options.now ?? Date.now;
  const sign = (value: string) => createHmac('sha256', secret).update(`${adminHash}:${dispatcherHash}:${value}`).digest('base64url');
  const csrf = (token: string) => sign(`csrf:${token}`);
  const session = (request: FastifyRequest): DispatcherSession | null => {
    const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || token.length > 500) return null;
    // Personal sessions: expires.role.account.nonce.sig; shared-password sessions: expires.role.nonce.sig.
    const parts = token.split('.');
    if (parts.length !== 4 && parts.length !== 5) return null;
    const [expires, role] = parts;
    const account = parts.length === 5 ? parts[2] : null;
    const nonce = parts[parts.length - 2];
    const signature = parts[parts.length - 1];
    const expiresAt = Number(expires);
    if ((role !== 'admin' && role !== 'dispatcher') || !nonce || !signature || (account !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(account))
      || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + SESSION_MS || !equal(signature, sign(parts.slice(0, -1).join('.')))) return null;
    return { token, expiresAt, role, dispatcherId: account, displayName: null, sessionId: createHash('sha256').update(token).digest('hex').slice(0, 32) };
  };
  const accounts = prisma.dispatcher;
  // A deactivated or re-roled account loses its session within a minute on every instance.
  const accountCache = new Map<string, { at: number; account: DispatcherAccount | null }>();
  const accountById = async (id: string) => {
    const cached = accountCache.get(id);
    if (cached && now() - cached.at < ACCOUNT_RECHECK_MS) return cached.account;
    const account = accounts ? await accounts.findUnique({ where: { id } }) : null;
    if (accountCache.size > 1000) accountCache.clear();
    accountCache.set(id, { at: now(), account });
    return account;
  };
  let accountsExist: { at: number; value: boolean } | null = null;
  const anyAccounts = async () => {
    if (!accounts) return false;
    if (accountsExist && now() - accountsExist.at < ACCOUNT_RECHECK_MS) return accountsExist.value;
    accountsExist = { at: now(), value: await accounts.count({ where: { active: true } }) > 0 };
    return accountsExist.value;
  };
  /** A valid signature is not enough for personal sessions: the account must still be active with the same role. */
  const resolve = async (found: DispatcherSession | null) => {
    if (!found || await isRevoked(found.sessionId)) return null;
    if (!found.dispatcherId) return found;
    const account = await accountById(found.dispatcherId);
    if (!account || !account.active || account.role !== found.role) return null;
    return { ...found, displayName: account.displayName };
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
      request.dispatcherSession = { token: 'disabled', expiresAt: Number.MAX_SAFE_INTEGER, role: 'admin', sessionId: 'disabled-test-session', dispatcherId: null, displayName: null };
      return;
    }
    if (path === '/health') return;
    if (!configured) return reply.code(503).send({ error: 'Вход диспетчерской ещё не настроен.' });
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation && (!request.headers.origin || !origins.has(request.headers.origin))) return reply.code(403).send({ error: 'Недопустимый источник запроса.' });
    if (path === '/auth/login' || path === '/auth/session') return;
    const current = await resolve(session(request));
    if (!current) return reply.code(401).send({ error: 'Войдите в диспетчерскую.' });
    request.dispatcherSession = current;
    if (mutation && !equal(String(request.headers['x-csrf-token'] ?? ''), csrf(current.token))) return reply.code(403).send({ error: 'Обновите страницу перед выполнением действия.' });
  });

  app.get('/auth/session', async (request, reply) => {
    if (options.disabled) return { authenticated: true, role: 'admin' as const, csrfToken: '', expiresAt: null, dispatcherId: null, displayName: null };
    const current = await resolve(session(request));
    reply.header('Cache-Control', 'no-store');
    return current
      ? { authenticated: true, role: current.role, csrfToken: csrf(current.token), expiresAt: new Date(current.expiresAt).toISOString(), dispatcherId: current.dispatcherId, displayName: current.displayName }
      : { authenticated: false, accountsEnabled: await anyAccounts() };
  });
  app.post('/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const bucket = Math.floor(now() / (15 * 60_000));
    const ip = createHash('sha256').update(request.ip).digest('hex').slice(0, 24);
    // Only wrong passwords count, so colleagues behind one office IP are not locked out by normal logins.
    const parsed = z.object({ login: z.string().trim().toLowerCase().max(40).optional(), password: z.string().min(1).max(1024) }).strict().safeParse(request.body);
    const login = parsed.success && parsed.data.login ? parsed.data.login : null;
    const failureKeys: Array<readonly [string, number]> = [[`auth:${bucket}:ip:${ip}`, LOGIN_FAILURES_PER_IP], [`auth:${bucket}:global`, LOGIN_FAILURES_TOTAL]];
    // Guessing one colleague's password from many addresses is limited too.
    if (login) failureKeys.push([`auth:${bucket}:login:${createHash('sha256').update(login).digest('hex').slice(0, 24)}`, LOGIN_FAILURES_PER_LOGIN]);
    for (const [id, limit] of failureKeys) {
      const quota = await prisma.apiQuota.findUnique({ where: { id } });
      if ((quota?.used ?? 0) >= limit) return reply.header('Retry-After', String(Math.ceil((900_000 - now() % 900_000) / 1000))).code(429).send({ error: 'Слишком много попыток. Попробуйте позднее.' });
    }
    const password = parsed.success ? parsed.data.password : null;
    let role: DispatcherRole | null = null;
    let account: DispatcherAccount | null = null;
    if (password !== null && login) {
      const found = accounts && LOGIN_PATTERN.test(login) ? await accounts.findUnique({ where: { login } }) : null;
      const matches = verifyDispatcherPassword(password, found?.passwordHash ?? DUMMY_HASH);
      if (found && matches && found.active && (found.role === 'admin' || found.role === 'dispatcher')) { account = found; role = found.role; }
    } else if (password !== null) {
      // Shared passwords: the admin one stays as the break-glass login; the dispatcher one ends with the first personal account.
      if (hashPattern.test(adminHash) && verifyDispatcherPassword(password, adminHash)) role = 'admin';
      else if (hashPattern.test(dispatcherHash) && verifyDispatcherPassword(password, dispatcherHash) && !await anyAccounts()) role = 'dispatcher';
    }
    if (!role) {
      for (const [id] of failureKeys) await prisma.apiQuota.upsert({ where: { id }, create: { id, used: 1 }, update: { used: { increment: 1 } } });
      return reply.code(401).send({ error: login ? 'Неверный логин или пароль.' : 'Неверный пароль.' });
    }
    const expiresAt = now() + SESSION_MS;
    const nonce = randomBytes(24).toString('base64url');
    const payload = account ? `${expiresAt}.${role}.${account.id}.${nonce}` : `${expiresAt}.${role}.${nonce}`;
    const token = `${payload}.${sign(payload)}`;
    if (account) await accounts?.update({ where: { id: account.id }, data: { lastLoginAt: new Date(now()) } });
    reply.header('Set-Cookie', cookie(token, SESSION_MS / 1000));
    return { authenticated: true, role, csrfToken: csrf(token), expiresAt: new Date(expiresAt).toISOString(), dispatcherId: account?.id ?? null, displayName: account?.displayName ?? null };
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
