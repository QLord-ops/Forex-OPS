let csrfToken = ''
let sessionRole: DispatcherSession['role'] | null = null
let sessionPerson: { id: string; name: string } | null = null
/** Role of the current session, for showing admin-only controls. The server still enforces every permission. */
export const currentDispatcherRole = () => sessionRole
/** Personal account of the session; null for the shared passwords of the transition period. */
export const currentDispatcher = () => sessionPerson
export const authHeaders = (): Record<string, string> => csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
export const notifySessionExpired = () => window.dispatchEvent(new Event('ops:session-expired'))
export interface DispatcherSession {
  authenticated: boolean
  role?: 'admin' | 'dispatcher'
  expiresAt?: string | null
  csrfToken?: string
  dispatcherId?: string | null
  displayName?: string | null
  /** Personal accounts exist, so the login field is required. */
  accountsEnabled?: boolean
}

export class DispatcherAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'DispatcherAuthError'
  }
}

async function call(path: string, body?: Record<string, string>): Promise<DispatcherSession> {
  const response = await fetch(`/api/auth/${path}`, {
    method: path === 'session' ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const result = await response.json().catch(() => ({})) as DispatcherSession & { error?: string }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('Retry-After'))
    throw new DispatcherAuthError(
      result.error || 'Не удалось подключиться к диспетчерской.',
      response.status,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    )
  }
  csrfToken = result.csrfToken ?? ''
  sessionRole = result.authenticated ? result.role ?? null : null
  sessionPerson = result.authenticated && result.dispatcherId ? { id: result.dispatcherId, name: result.displayName ?? '' } : null
  return result
}
export const dispatcherAuth = {
  session: () => call('session'),
  login: (login: string, password: string) => call('login', login.trim() ? { login: login.trim(), password } : { password }),
  logout: () => call('logout', {})
}
