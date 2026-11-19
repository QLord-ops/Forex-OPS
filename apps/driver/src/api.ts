export type DriverVehicle = { vehicleNumber: string; licensePlate: string | null }
export type DriverSession =
  | { authenticated: true; csrfToken: string; expiresAt: string; vehicle: DriverVehicle }
  | { authenticated: false }

export type DriverStop = {
  id: string; sequence: number; type: 'LOAD' | 'UNLOAD'; company: string | null; address: string; city: string | null
  latitude: number; longitude: number
  appointmentAt: string | null; windowStartAt: string | null; windowEndAt: string | null
  loadingMeters: number | null; references: string[]; instructions: string | null
  arrivedAt: string | null; completedAt: string | null; samePlaceAsPrevious: boolean; undoUntil: string | null
}
export type DriverEta = { at: string | null; source: 'WEBFLEET' | 'WEBFLEET_STALE' | 'CALCULATED' }
export type DriverTour = { id: string; orderNumber: string; tourRemarks: string | null; trailerPlate: string | null; currentStopId: string | null; eta: DriverEta | null; stops: DriverStop[] }
export type TourView = {
  serverTime: string
  vehicle: DriverVehicle
  tour: DriverTour | null
  next: { orderNumber: string; company: string | null; city: string | null; appointmentAt: string | null } | null
  /** The driver's mark that closed the previous tour, while it can still be taken back. */
  lastMark: { stopId: string; type: 'LOAD' | 'UNLOAD'; company: string | null; city: string | null; orderNumber: string; completedAt: string; undoUntil: string } | null
}
export const PROBLEMS = [
  ['WAITING', 'Долго жду'], ['NO_GOODS', 'Груз не готов'], ['DAMAGE', 'Повреждение'], ['ADDRESS', 'Не тот адрес или ворота'], ['OTHER', 'Другое']
] as const
export type ProblemKind = typeof PROBLEMS[number][0]

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

const post = <T,>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const driverApi = {
  session: async () => remember(await request<DriverSession>('/driver/auth/session')),
  login: async (vehicle: string, code: string) => remember(await post<DriverSession>('/driver/auth/login', { vehicle, code })),
  logout: async () => remember(await post<DriverSession>('/driver/auth/logout')),
  tour: () => request<TourView>('/driver/tour'),
  arrived: (stopId: string) => post<TourView>(`/driver/stops/${stopId}/arrived`),
  done: (stopId: string) => post<TourView>(`/driver/stops/${stopId}/done`),
  undo: (stopId: string) => post<TourView>(`/driver/stops/${stopId}/undo`),
  problem: (stopId: string, kind: ProblemKind, note: string) => post<{ ok: true }>(`/driver/stops/${stopId}/problem`, { kind, ...(note.trim() ? { note: note.trim() } : {}) })
}
