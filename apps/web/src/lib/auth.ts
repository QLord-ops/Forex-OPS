let csrfToken = ''
export const authHeaders = (): Record<string, string> => csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
export const notifySessionExpired = () => window.dispatchEvent(new Event('ops:session-expired'))
export interface DispatcherSession { authenticated: boolean; expiresAt?: string | null; csrfToken?: string }
async function call(path: string, password?: string): Promise<DispatcherSession> {
  const response = await fetch(`/api/auth/${path}`, {
    method: path === 'session' ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    ...(password === undefined ? {} : { body: JSON.stringify({ password }) })
  })
  const result = await response.json() as DispatcherSession & { error?: string }
  if (!response.ok) throw new Error(result.error || 'Не удалось подключиться к диспетчерской.')
  csrfToken = result.csrfToken ?? ''
  return result
}
export const dispatcherAuth = { session: () => call('session'), login: (password: string) => call('login', password), logout: () => call('logout') }
