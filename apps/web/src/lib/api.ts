import type {
  Alert,
  AppointmentAnalysis,
  AppointmentDocument,
  AppointmentMatch,
  PendingAppointment,
  AddressResolution,
  CreateTourInput,
  CurrentPosition,
  DashboardResponse,
  OrderImportPreview,
  GeocodeResult,
  HistoryResponse,
  Tour,
  Vehicle,
  VehicleCardData,
  VehicleTrack,
  VehicleTimeline
} from '../types/domain'

import { authHeaders, notifySessionExpired } from './auth'
const API_BASE = '/api'

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body && !(init.body instanceof FormData)
    ? { 'Content-Type': 'application/json', ...init.headers }
    : init?.headers
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { ...headers, ...authHeaders() }
  })

  if (!response.ok) {
    if (response.status === 401) notifySessionExpired()
    throw new ApiError(await readErrorMessage(response), response.status)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

/**
 * Turns an error response into a short Russian message. Only the API's own JSON `error`/`message` is shown;
 * proxy pages, HTML and stack traces never reach the dispatcher (CLAUDE.md rule 1).
 */
export async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
    const value = typeof parsed.error === 'string' ? parsed.error : typeof parsed.message === 'string' ? parsed.message : ''
    if (value.trim() && value.length <= 500) return value.trim()
  } catch {
    // Not JSON: a proxy or gateway page.
  }
  if (response.status === 401) return 'Сессия истекла. Войдите снова.'
  if (response.status === 403) return 'Недостаточно прав для этого действия.'
  if (response.status === 404) return 'Данные не найдены. Обновите страницу.'
  if (response.status === 409) return 'Данные изменились. Обновите страницу и повторите.'
  if (response.status === 429) return 'Слишком много запросов. Подождите минуту и повторите.'
  if (response.status >= 500) return 'Сервер временно недоступен. Повторите через минуту.'
  return `Не удалось выполнить запрос (код ${response.status}).`
}

export interface DispatcherAccount {
  id: string
  login: string
  displayName: string
  role: 'admin' | 'dispatcher'
  active: boolean
  lastLoginAt: string | null
  createdAt: string
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

export const accountsApi = {
  list: () => request<DispatcherAccount[]>('/dispatchers'),
  directory: () => request<Array<{ id: string; displayName: string }>>('/dispatchers/directory'),
  create: (input: { login: string; displayName: string; role: 'admin' | 'dispatcher'; password: string }) => request<DispatcherAccount>('/dispatchers', json('POST', input)),
  update: (id: string, input: Partial<Pick<DispatcherAccount, 'displayName' | 'role' | 'active'>>) => request<DispatcherAccount>(`/dispatchers/${encodeURIComponent(id)}`, json('PATCH', input)),
  resetPassword: (id: string, password: string) => request<{ ok: true }>(`/dispatchers/${encodeURIComponent(id)}/password`, json('POST', { password })),
  changeOwnPassword: (currentPassword: string, newPassword: string) => request<{ ok: true }>('/auth/password', json('POST', { currentPassword, newPassword }))
}

export const api = {
  dashboard: () => request<DashboardResponse>('/dashboard'),
  vehicles: () => request<Vehicle[]>('/vehicles'),
  createVehicle: (payload: { vehicleNumber: string; licensePlate?: string; maxSpeedKmh?: number }) =>
    request<Vehicle>('/vehicles', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  vehicle: (id: string) => request<Vehicle>(`/vehicles/${id}`),
  vehicleTours: (id: string) => request<Tour[]>(`/vehicles/${id}/tours`),
  vehicleTimeline: (id: string) => request<VehicleTimeline>(`/vehicles/${id}/timeline`),
  assignVehicle: (id: string, input: { action: 'take' | 'release' | 'handover' | 'reassign'; expectedDispatcherId: string | null; toDispatcherId?: string | null }) =>
    request<{ vehicleId: string; assignedTo: { id: string; name: string } | null }>(`/vehicles/${encodeURIComponent(id)}/assignment`, { method: 'POST', body: JSON.stringify(input) }),
  vehicleCard: (id: string) => request<VehicleCardData>(`/vehicles/${encodeURIComponent(id)}/card`),
  vehicleTrack: (id: string) => request<VehicleTrack>(`/vehicles/${encodeURIComponent(id)}/track`),
  currentPosition: (id: string, includeGeometry = true) => request<CurrentPosition>(`/vehicles/${id}/current-position${includeGeometry ? '' : '?geometry=0'}`),
  tours: () => request<Tour[]>('/tours'),
  tour: (id: string) => request<Tour>(`/tours/${id}`),
  createTour: (payload: CreateTourInput) =>
    request<Tour>('/tours', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  confirmImportedTour: (payload: CreateTourInput & { importAttemptId: string; importFingerprint: string }) =>
    request<{ tour: Tour; created: boolean; reused: boolean }>('/imports/tours/confirm', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  createTourWithVehicle: (payload: { vehicle: { vehicleNumber: string; licensePlate?: string }; tour: Omit<CreateTourInput, 'vehicleId'> }) =>
    request<{ vehicle: Vehicle; tour: Tour }>('/tours/with-new-vehicle', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  previewNewTour: (payload: { vehicleId?: string; stops: Array<Pick<CreateTourInput['stops'][number], 'address'> & Partial<Pick<CreateTourInput['stops'][number], 'latitude' | 'longitude'>>> }) =>
    request<{ distanceMeters: number; durationSeconds: number; estimatedArrivalAt: string | null; preliminary: boolean; geometry: Array<[number, number]> }>('/tours/preview', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  setManualPosition: (vehicleId: string, address: string) =>
    request<{ address: string; latitude: number; longitude: number; approachDurationSeconds: number | null }>(`/vehicles/${vehicleId}/manual-position`, {
      method: 'PUT',
      body: JSON.stringify({ address })
    }),
  updateTour: (id: string, payload: (CreateTourInput & { version?: number }) | { status: 'CANCELLED'; version?: number }) =>
    request<Tour>(`/tours/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),
  markLoaded: (stopId: string, timestamp?: string) =>
    request<Tour>(`/stops/${stopId}/loaded`, {
      method: 'POST',
      body: JSON.stringify(timestamp ? { timestamp } : {})
    }),
  markUnloaded: (stopId: string, timestamp?: string) =>
    request<Tour>(`/stops/${stopId}/unloaded`, {
      method: 'POST',
      body: JSON.stringify(timestamp ? { timestamp } : {})
    }),
  manualStop: (vehicleId: string, version: number) =>
    request(`/vehicles/${vehicleId}/manual-stop`, {
      method: 'POST',
      body: JSON.stringify({ version })
    }),
  resumeVehicle: (vehicleId: string, version: number) =>
    request(`/vehicles/${vehicleId}/resume`, {
      method: 'POST',
      body: JSON.stringify({ version })
    }),
  previewAppointment: (stopId: string, appointmentAt: string) =>
    request<AppointmentAnalysis>(`/stops/${stopId}/appointment/preview`, {
      method: 'POST',
      body: JSON.stringify({ appointmentAt })
    }),
  previewAppointmentSlot: (stopId: string, slot: { appointmentAt?: string | null; windowStartAt?: string | null; windowEndAt?: string | null }) =>
    request<AppointmentAnalysis>(`/stops/${stopId}/appointment/preview`, { method: 'POST', body: JSON.stringify(slot) }),
  matchAppointment: (document: AppointmentDocument) =>
    request<AppointmentMatch>('/appointments/match', { method: 'POST', body: JSON.stringify(document) }),
  applyAppointmentDocument: (payload: { stopId: string; version: number; fingerprint: string; pendingId?: string | null; document: AppointmentDocument }) =>
    request<AppointmentAnalysis>('/appointments/from-document', { method: 'POST', body: JSON.stringify(payload) }),
  savePendingAppointment: (payload: { fingerprint: string; document: AppointmentDocument }) =>
    request<{ id: string; status: string }>('/appointments/pending', { method: 'POST', body: JSON.stringify(payload) }),
  pendingAppointments: () => request<{ items: PendingAppointment[] }>('/appointments/pending'),
  dismissPendingAppointment: (id: string) => request<{ ok: true }>(`/appointments/pending/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: '{}' }),
  applyAppointment: (stopId: string, payload: { appointmentAt: string; version: number }) =>
    request<AppointmentAnalysis>(`/stops/${stopId}/appointment`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  alerts: () => request<Alert[]>('/alerts'),
  history: (vehicleId?: string) =>
    request<HistoryResponse>(vehicleId ? `/history?vehicleId=${encodeURIComponent(vehicleId)}` : '/history'),
  importExcel: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return request<OrderImportPreview>('/imports/excel/preview', { method: 'POST', body })
  },
  importPdf: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return request<OrderImportPreview>('/imports/pdf/preview', { method: 'POST', body })
  },
  importImage: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return request<OrderImportPreview>('/imports/image/preview', { method: 'POST', body })
  },
  geocode: (address: string) => request<GeocodeResult>(`/geocode?address=${encodeURIComponent(address)}`),
  resolveAddress: (payload: { address: string; city?: string | null }) =>
    request<AddressResolution>('/geocode/resolve', { method: 'POST', body: JSON.stringify(payload) })
}
