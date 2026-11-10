import type {
  Coordinate,
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
  ImportSpeedSummary,
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

/** The saved Auftrag file; the browser opens it with the session cookie. */
export function documentFileUrl(documentId: string) {
  return `${API_BASE}/documents/${encodeURIComponent(documentId)}/file`
}

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
  onboardingCompletedAt?: string | null
  lines?: Array<{ lineId: string; isPrimary: boolean }>
  role: 'admin' | 'dispatcher'
  active: boolean
  lastLoginAt: string | null
  createdAt: string
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

/** An Auftrag upload; `customerId` picks the customer profile the AI reads it with ('auto' or nothing: detected after reading). */
function importFile(path: string, file: File, customerId?: string | null) {
  const body = new FormData()
  body.append('file', file)
  const query = customerId ? `?customerId=${encodeURIComponent(customerId)}` : ''
  return importResult(`${path}${query}`, { method: 'POST', body })
}

const IMPORT_POLL_MS = 2000

/**
 * Reading an Auftrag can take minutes. The server answers 202 with a job once it has read for a while; the page then asks
 * for the result every two seconds until it is there (or the reading failed with its own message).
 */
async function importResult(path: string, init: RequestInit): Promise<OrderImportPreview> {
  return jobResult<OrderImportPreview>(path, init)
}

/** Any long server job answered the same way: the result at once, or 202 with a job to poll until it is done. */
async function jobResult<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'same-origin', headers: { ...init.headers, ...authHeaders() } })
  if (!response.ok) {
    if (response.status === 401) notifySessionExpired()
    throw new ApiError(await readErrorMessage(response), response.status)
  }
  const payload = await response.json() as T | { status: 'running'; jobId: string }
  if (response.status !== 202 || !(typeof payload === 'object' && payload !== null && 'jobId' in payload)) return payload as T
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_MS))
    const poll = await fetch(`${API_BASE}/imports/jobs/${encodeURIComponent(payload.jobId)}`, { credentials: 'same-origin', headers: authHeaders() })
    if (!poll.ok) {
      if (poll.status === 401) notifySessionExpired()
      throw new ApiError(await readErrorMessage(poll), poll.status)
    }
    const state = await poll.json() as { status: 'running' } | { status: 'done'; preview: T }
    if (state.status === 'done') return state.preview
  }
}

export type CustomerCategory = 'OEM_LOGISTICS' | 'WAREHOUSE' | 'SPOT' | 'OTHER'
export interface CustomerProfile {
  version: 1
  import: { routeSource: 'TOUR_REMARKS' | 'TABLE' | 'EMAIL_TEXT'; warehouseWords: string[]; carrierNames: string[]; dateOnlyMeansPlannedStart: boolean; zuladungWords: string[]; aiNotes: string }
  statusList: { enabled: boolean; dueLocalTime: string; excludedVehicles: string[]; weColumnLabel: string | null; showASchild: boolean; showAppSped: boolean }
  defaults: { serviceMinMinutes: number; serviceMaxMinutes: number; arrivalRadiusMeters: number }
}
export interface CustomerLine {
  id: string; customerId: string; code: string; name: string; active: boolean; sortIndex: number
  departmentCompany: string | null; departmentAddress: string | null; departmentCity: string | null
  vehicleCount: number; dispatchers: Array<{ id: string; name: string; primary: boolean }>
}
export interface Customer {
  id: string; name: string; slug: string; category: CustomerCategory; color: string | null; active: boolean
  aliases: string[]; profile: CustomerProfile; lines: CustomerLine[]; createdAt: string; updatedAt: string
}
export interface CustomerOverview {
  vehicles: number; activeTours: number; tours30d: number; documents: number; documentsWithoutCorrections: number
  mostCorrected: Array<{ field: string; count: number }>; learnedRules: number
  /** Of the fields shown as fine / check / doubt in the last 30 saved Auftrag, how many the dispatchers changed. Null before the first one. */
  accuracy: Record<'OK' | 'CHECK' | 'DOUBT', { fields: number; changed: number }> | null
  recentDocuments: Array<{ id: string; filename: string; mimeType: string; status: string; tourId: string | null; createdAt: string }>
}
export interface CustomerMigrationItem { slug: string; name: string; exists: boolean; statusList: boolean; lines: Array<{ code: string; name: string; vehicles: string[] }> }
type ProfilePatch = { import?: Partial<CustomerProfile['import']>; statusList?: Partial<CustomerProfile['statusList']>; defaults?: Partial<CustomerProfile['defaults']> }

export const customersApi = {
  list: () => request<{ customers: Customer[] }>('/customers').then((result) => result.customers),
  get: (id: string) => request<Customer & { overview: CustomerOverview }>(`/customers/${encodeURIComponent(id)}`),
  create: (input: { name: string; category?: CustomerCategory; aliases?: string[]; color?: string | null }) => request<{ id: string }>('/customers', json('POST', input)),
  update: (id: string, input: { name?: string; category?: CustomerCategory; aliases?: string[]; color?: string | null; active?: boolean; profile?: ProfilePatch }) =>
    request<{ id: string }>(`/customers/${encodeURIComponent(id)}`, json('PATCH', input)),
  addLine: (customerId: string, input: { code: string; name: string; departmentCompany?: string | null; departmentAddress?: string | null; departmentCity?: string | null }) =>
    request<{ id: string }>(`/customers/${encodeURIComponent(customerId)}/lines`, json('POST', input)),
  updateLine: (id: string, input: { name?: string; active?: boolean; departmentCompany?: string | null; departmentAddress?: string | null; departmentCity?: string | null; sortIndex?: number }) =>
    request<{ id: string }>(`/customer-lines/${encodeURIComponent(id)}`, json('PATCH', input)),
  setVehicleLine: (vehicleId: string, lineId: string | null) => request<{ id: string }>(`/vehicles/${encodeURIComponent(vehicleId)}/customer-line`, json('PUT', { lineId })),
  setDispatcherLines: (dispatcherId: string, lineIds: string[], primaryLineId: string | null) =>
    request<{ lines: unknown[] }>(`/dispatchers/${encodeURIComponent(dispatcherId)}/lines`, json('PUT', { lineIds, primaryLineId })),
  migrationPreview: () => request<{ customers: CustomerMigrationItem[] }>('/customers/migration-preview').then((result) => result.customers),
  migrate: () => request<{ result: Array<{ slug: string; created: boolean; lines: number; vehicles: number }> }>('/customers/migrate-from-lines', json('POST', {})).then((result) => result.result)
}

export const accountsApi = {
  list: () => request<DispatcherAccount[]>('/dispatchers'),
  directory: () => request<Array<{ id: string; displayName: string }>>('/dispatchers/directory'),
  create: (input: { login: string; displayName: string; role: 'admin' | 'dispatcher'; password: string }) => request<DispatcherAccount>('/dispatchers', json('POST', input)),
  update: (id: string, input: Partial<Pick<DispatcherAccount, 'displayName' | 'role' | 'active'>>) => request<DispatcherAccount>(`/dispatchers/${encodeURIComponent(id)}`, json('PATCH', input)),
  resetPassword: (id: string, password: string) => request<{ ok: true }>(`/dispatchers/${encodeURIComponent(id)}/password`, json('POST', { password })),
  changeOwnPassword: (currentPassword: string, newPassword: string) => request<{ ok: true }>('/auth/password', json('POST', { currentPassword, newPassword })),
  onboarding: (completed: boolean) => request<{ ok: true; stored: boolean; onboardingCompletedAt?: string | null }>('/auth/onboarding', json('POST', { completed }))
}

export interface AddressRule { id: string; pattern: string; kind: string; company: string | null; street: string | null; postalCode: string | null; city: string | null
  latitude: number | null; longitude: number | null; requiresTermin: boolean; hits: number; updatedAt: string }
export interface ImportRule {
  id: string; kind: string; pattern: string; value: string | null; active: boolean; hits: number; applied: number; builtIn: boolean; lastSeenAt: string | null; createdAt: string; updatedAt: string
  /** 'global' or the customer id the rule was learned for. */
  scope: string
  customer: { id: string; name: string } | null
  /** Switched on at two or more customers: an admin may make it common. */
  promotable: boolean
}
export interface RouteOption { id: string; distanceMeters: number; durationSeconds: number; trafficDelaySeconds: number; mainRoads: string[]; providerStatus: string; geometry: Coordinate[] }
export interface RouteOptions { vehicleId: string; version: number; legId: string; checkedAt: string; offRouteMeters: number | null
  current: { remainingDistanceMeters: number; eta: string | null; geometry: Coordinate[] }; options: RouteOption[] }

export const api = {
  dashboard: () => request<DashboardResponse>('/dashboard'),
  vehicles: () => request<Vehicle[]>('/vehicles'),
  updateVehicle: (id: string, payload: { vehicleNumber?: string; licensePlate?: string; maxSpeedKmh?: number }) =>
    request<Vehicle>(`/vehicles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
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
  confirmImportedTour: (payload: CreateTourInput & { importAttemptId: string; importFingerprint: string; documentId?: string | null }) =>
    request<{ tour: Tour; created: boolean; reused: boolean }>('/imports/tours/confirm', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  createTourWithVehicle: (payload: { vehicle: { vehicleNumber: string; licensePlate?: string }; tour: Omit<CreateTourInput, 'vehicleId'> & { documentId?: string | null } }) =>
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
  addressRules: () => request<{ rules: AddressRule[]; builtIn: Array<Pick<AddressRule, 'pattern' | 'kind' | 'company' | 'city' | 'requiresTermin'>> }>('/address-rules'),
  updateAddressRule: (id: string, patch: Partial<Pick<AddressRule, 'company' | 'street' | 'postalCode' | 'city' | 'requiresTermin'>>) =>
    request<AddressRule>(`/address-rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAddressRule: (id: string) => request<void>(`/address-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  importRules: (customerId?: string | null) => request<{ rules: ImportRule[]; builtIn: Array<Pick<ImportRule, 'kind' | 'pattern' | 'value'>>; corrections: { last7d: number } }>(
    customerId ? `/import-rules?customerId=${encodeURIComponent(customerId)}` : '/import-rules'),
  promoteImportRule: (id: string) => request<ImportRule>(`/import-rules/${encodeURIComponent(id)}/promote`, { method: 'POST', body: '{}' }),
  updateImportRule: (id: string, patch: { active?: boolean; value?: string | null }) =>
    request<ImportRule>(`/import-rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteImportRule: (id: string) => request<void>(`/import-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Three routes from the truck's GPS position to its next stop (TomTom). */
  routeOptions: (vehicleId: string) => request<RouteOptions>(`/vehicles/${encodeURIComponent(vehicleId)}/route-options`, { method: 'POST', body: '{}' }),
  applyRouteOption: (vehicleId: string, optionId: string, version: number) =>
    request<unknown>(`/vehicles/${encodeURIComponent(vehicleId)}/route-options/apply`, { method: 'POST', body: JSON.stringify({ optionId, version }) }),
  markLoaded: (stopId: string, timestamp?: string, manual = false) =>
    request<Tour>(`/stops/${stopId}/loaded`, {
      method: 'POST',
      body: JSON.stringify({ ...(timestamp ? { timestamp } : {}), ...(manual ? { manual } : {}) })
    }),
  markUnloaded: (stopId: string, timestamp?: string, manual = false) =>
    request<Tour>(`/stops/${stopId}/unloaded`, {
      method: 'POST',
      body: JSON.stringify({ ...(timestamp ? { timestamp } : {}), ...(manual ? { manual } : {}) })
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
  /** scope 'STOP' keeps the Termin on this stop alone; by default it is the Termin of the whole place. */
  previewAppointment: (stopId: string, appointmentAt: string, scope?: 'PLACE' | 'STOP') =>
    request<AppointmentAnalysis>(`/stops/${stopId}/appointment/preview`, {
      method: 'POST',
      body: JSON.stringify({ appointmentAt, scope })
    }),
  previewAppointmentSlot: (stopId: string, slot: { appointmentAt?: string | null; windowStartAt?: string | null; windowEndAt?: string | null }, scope?: 'PLACE' | 'STOP') =>
    request<AppointmentAnalysis>(`/stops/${stopId}/appointment/preview`, { method: 'POST', body: JSON.stringify({ ...slot, scope }) }),
  matchAppointment: (document: AppointmentDocument) =>
    request<AppointmentMatch>('/appointments/match', { method: 'POST', body: JSON.stringify(document) }),
  applyAppointmentDocument: (payload: { stopId: string; version: number; fingerprint: string; pendingId?: string | null; document: AppointmentDocument; scope?: 'PLACE' | 'STOP' }) =>
    request<AppointmentAnalysis>('/appointments/from-document', { method: 'POST', body: JSON.stringify(payload) }),
  savePendingAppointment: (payload: { fingerprint: string; document: AppointmentDocument }) =>
    request<{ id: string; status: string }>('/appointments/pending', { method: 'POST', body: JSON.stringify(payload) }),
  pendingAppointments: () => request<{ items: PendingAppointment[] }>('/appointments/pending'),
  dismissPendingAppointment: (id: string) => request<{ ok: true }>(`/appointments/pending/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: '{}' }),
  applyAppointment: (stopId: string, payload: { appointmentAt: string; version: number; scope?: 'PLACE' | 'STOP' }) =>
    request<AppointmentAnalysis>(`/stops/${stopId}/appointment`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  alerts: () => request<Alert[]>('/alerts'),
  history: (vehicleId?: string) =>
    request<HistoryResponse>(vehicleId ? `/history?vehicleId=${encodeURIComponent(vehicleId)}` : '/history'),
  importExcel: (file: File, customerId?: string | null) => importFile('/imports/excel/preview', file, customerId),
  importPdf: (file: File, customerId?: string | null) => importFile('/imports/pdf/preview', file, customerId),
  importImage: (file: File, customerId?: string | null) => importFile('/imports/image/preview', file, customerId),
  /** The stored Auftrag read again with another customer's profile (null: automatic detection). */
  reparseDocument: (documentId: string, customerId: string | null) =>
    importResult(`/documents/${encodeURIComponent(documentId)}/reparse`, { method: 'POST', body: JSON.stringify({ customerId }), headers: { 'Content-Type': 'application/json' } }),
  geocode: (address: string) => request<GeocodeResult>(`/geocode?address=${encodeURIComponent(address)}`),
  resolveAddress: (payload: { address: string; city?: string | null; company?: string | null }) =>
    request<AddressResolution>('/geocode/resolve', { method: 'POST', body: JSON.stringify(payload) }),
  importSpeed: () => request<ImportSpeedSummary>('/imports/stats'),
  checkStopCoordinates: () => jobResult<StopCoordinateIssue[]>('/maintenance/stop-coordinates', { method: 'GET' }),
  fixStopCoordinates: (stopIds: string[]) =>
    jobResult<{ fixed: StopCoordinateIssue[]; skipped: Array<{ vehicleNumber: string; stopIds: string[]; reason: string }> }>('/maintenance/stop-coordinates/fix', { method: 'POST', body: JSON.stringify({ stopIds }), headers: { 'Content-Type': 'application/json' } })
}

export interface StopCoordinateIssue {
  stopId: string; tourId: string; tourStatus: string; orderNumber: string; vehicleId: string; vehicleNumber: string
  sequence: number; type: string; company: string | null; address: string; city: string | null
  current: { latitude: number; longitude: number; resolvedAddress: string | null }
  proposed: { latitude: number; longitude: number; resolvedAddress: string; precision: string; provider?: string }
  distanceKm: number; attempts: string[]
}
