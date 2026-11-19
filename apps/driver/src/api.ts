export type DriverVehicle = { vehicleNumber: string; licensePlate: string | null }
export type DriverSession =
  | { authenticated: true; csrfToken: string; expiresAt: string; vehicle: DriverVehicle }
  | { authenticated: false }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

let csrfToken = ''

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const mutation = init.method && init.method !== 'GET'
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(mutation ? { 'x-csrf-token': csrfToken } : {}), ...init.headers }
    })
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте интернет и повторите.', 0)
  }
  const body = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new ApiError(body?.error ?? 'Сервер не ответил. Повторите через минуту.', response.status)
  return body as T
}

function remember(session: DriverSession): DriverSession {
  csrfToken = session.authenticated ? session.csrfToken : ''
  return session
}

export const driverApi = {
  session: async () => remember(await request<DriverSession>('/driver/auth/session')),
  login: async (vehicle: string, code: string) => remember(await request<DriverSession>('/driver/auth/login', { method: 'POST', body: JSON.stringify({ vehicle, code }) })),
  logout: async () => remember(await request<DriverSession>('/driver/auth/logout', { method: 'POST' }))
}
