import { ApiError } from './api'
import { authHeaders, notifySessionExpired } from './auth'
import type { AssistantConversation, AssistantProposal, AssistantReply, AssistantThread, RouteScenario } from '../types/assistant'

const API_BASE = '/api'
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/assistant${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { ...authHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (response.status === 401) notifySessionExpired()
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string; message?: string }
    throw new ApiError(result.error || result.message || 'Не удалось связаться с помощником', response.status)
  }
  return response.json() as Promise<T>
}
export const assistantApi = {
  conversations: () => request<AssistantConversation[]>('/conversations'),
  create: () => request<AssistantConversation>('/conversations', {}),
  messages: (id: string) => request<AssistantThread>(`/conversations/${encodeURIComponent(id)}/messages`),
  send: (id: string, body: { text: string; vehicleId?: string; draft?: { action: string; input: Record<string, unknown> } }) => request<AssistantReply>(`/conversations/${encodeURIComponent(id)}/messages`, body),
  confirm: (id: string) => request<AssistantProposal>(`/proposals/${encodeURIComponent(id)}/confirm`, {}),
  cancel: (id: string) => request<AssistantProposal>(`/proposals/${encodeURIComponent(id)}/cancel`, {})
}

export type RouteScenarioRequest = {
  vehicleId?: string
  originAddress?: string
  startMode?: 'AFTER_CURRENT_TOUR' | 'NOW' | 'AFTER_QUEUE'
  startAt?: string
  includeQueueImpact?: boolean
  stops: Array<{ address: string; type?: 'LOAD' | 'UNLOAD' | 'VISIT'; coords?: { latitude: number; longitude: number }; appointmentAt?: string | null; serviceMinMinutes?: number; serviceMaxMinutes?: number }>
  /** Picked variant per stop: re-times the plan without a new routing request. */
  legChoices?: Array<{ distanceMeters: number; durationSeconds: number } | null>
}

export async function previewRouteScenario(body: RouteScenarioRequest, signal?: AbortSignal): Promise<RouteScenario> {
  const response = await fetch(`${API_BASE}/route-scenarios/preview`, { method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
  if (response.status === 401) notifySessionExpired()
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string; message?: string }
    throw new ApiError(result.error || result.message || 'Не удалось рассчитать сценарий', response.status)
  }
  return response.json() as Promise<RouteScenario>
}
