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

export async function previewRouteScenario(body: { vehicleId: string; startMode: 'AFTER_CURRENT_TOUR' | 'NOW' | 'AFTER_QUEUE'; startAt?: string; stops: Array<{ address: string; type: 'LOAD' | 'UNLOAD' | 'VISIT'; appointmentAt?: string | null; serviceMinMinutes?: number; serviceMaxMinutes?: number }> }): Promise<RouteScenario> {
  const response = await fetch(`${API_BASE}/route-scenarios/preview`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
  if (response.status === 401) notifySessionExpired()
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string; message?: string }
    throw new ApiError(result.error || result.message || 'Не удалось рассчитать сценарий', response.status)
  }
  return response.json() as Promise<RouteScenario>
}
