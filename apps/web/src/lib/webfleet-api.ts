import { authHeaders, notifySessionExpired } from './auth'

export interface WebfleetConnectionStatus {
  configured: boolean
  mode: 'READ_ONLY'
  pollingIntervalSeconds: number
  lastSnapshotAt: string | null
  summary: unknown
  lastError: string | null
  retryAfter: string | null
}

async function request(method: 'GET' | 'POST', signal?: AbortSignal): Promise<WebfleetConnectionStatus> {
  const response = await fetch(`/api/integrations/webfleet/${method === 'GET' ? 'status' : 'sync'}`, {
    method,
    credentials: 'same-origin',
    signal,
    headers: { ...authHeaders(), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {})
  })
  if (!response.ok) {
    if (response.status === 401) notifySessionExpired()
    // Provider errors may contain account details. Do not display their raw response.
    throw new Error(response.status === 401
      ? 'Сессия завершена. Войдите снова.'
      : response.status === 429
        ? 'Webfleet ограничил частоту запросов. Повторите проверку позже.'
        : 'Не удалось проверить Webfleet. Проверьте подключение и настройки на сервере.')
  }
  return response.json() as Promise<WebfleetConnectionStatus>
}

export const webfleetApi = {
  status: () => request('GET'),
  sync: (signal?: AbortSignal) => request('POST', signal)
}
