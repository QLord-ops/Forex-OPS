import type {
  Alert,
  AppointmentAnalysis,
  CreateTourInput,
  CurrentPosition,
  DashboardResponse,
  OrderImportPreview,
  GeocodeResult,
  HistoryResponse,
  Tour,
  Vehicle,
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
    const text = await response.text()
    let message = text
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      // Keep the plain response body when the server did not return JSON.
    }
    throw new ApiError(message || `Ошибка API ${response.status}`, response.status)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
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
  currentPosition: (id: string, includeGeometry = true) => request<CurrentPosition>(`/vehicles/${id}/current-position${includeGeometry ? '' : '?geometry=0'}`),
  tours: () => request<Tour[]>('/tours'),
  tour: (id: string) => request<Tour>(`/tours/${id}`),
  createTour: (payload: CreateTourInput) =>
    request<Tour>('/tours', {
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
  updateTour: (id: string, payload: CreateTourInput | { status: 'CANCELLED' }) =>
    request<Tour>(`/tours/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),
  confirmArrival: (stopId: string, arrivedAt: string) =>
    request(`/stops/${stopId}/arrival`, {
      method: 'POST',
      body: JSON.stringify({ arrivedAt })
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
  geocode: (address: string) => request<GeocodeResult>(`/geocode?address=${encodeURIComponent(address)}`)
}
