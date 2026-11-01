import { authHeaders, notifySessionExpired } from './auth'

export type WebfleetErrorCategory = 'AUTH' | 'PERMISSION' | 'RATE_LIMIT' | 'NETWORK' | 'INVALID_RESPONSE' | 'CONFIG' | 'UNKNOWN'

export interface WebfleetConnectionStatus {
  configured: boolean
  mode: 'READ_ONLY'
  pollingIntervalSeconds: number
  lastSnapshotAt: string | null
  summary: unknown
  lastError: string | null
  errorCategory: WebfleetErrorCategory | null
  providerErrorCode: number | null
  retryAfter: string | null
}

export interface WebfleetBinding {
  vehicleId: string
  vehicleNumber: string
  licensePlate: string | null
  objectUid: string
  objectNo: string | null
  externalPlate: string | null
  status: string
  boundAt: string
}

export const webfleetErrorText: Record<WebfleetErrorCategory, string> = {
  AUTH: 'Webfleet отклонил вход. Проверьте аккаунт, пользователя, пароль и API key на сервере. Повтор — не раньше чем через 30 минут, чтобы Webfleet не заблокировал пользователя.',
  PERMISSION: 'Вход принят, но пользователю не хватает права WEBFLEET.connect или доступа к группе машин.',
  RATE_LIMIT: 'Webfleet временно ограничил частоту запросов. Следующая попытка будет автоматически.',
  NETWORK: 'Webfleet не ответил. Возможно, сбой сети или сервиса.',
  INVALID_RESPONSE: 'Webfleet вернул неожиданный ответ. Проверьте, что ключ выдан для WEBFLEET.connect.',
  CONFIG: 'Неверный адрес Webfleet на сервере. Должен быть https://csv.webfleet.com/extern.',
  UNKNOWN: 'Webfleet вернул неизвестную ошибку.'
}

async function request<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/integrations/webfleet/${path}`, {
    method,
    credentials: 'same-origin',
    signal,
    headers: { ...authHeaders(), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) })
  })
  if (!response.ok) {
    if (response.status === 401) notifySessionExpired()
    // Our API returns safe Russian messages for 4xx; raw provider output is never shown.
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(response.status === 401
      ? 'Сессия завершена. Войдите снова.'
      : response.status === 403
        ? 'Это действие доступно только администратору.'
        : response.status === 429
          ? 'Слишком много запросов. Повторите позже.'
          : response.status < 500 && payload.error
            ? payload.error
            : 'Не удалось выполнить запрос Webfleet. Проверьте подключение и настройки на сервере.')
  }
  return response.json() as Promise<T>
}

export const webfleetApi = {
  status: () => request<WebfleetConnectionStatus>('status', 'GET'),
  sync: (signal?: AbortSignal) => request<WebfleetConnectionStatus>('sync', 'POST', {}, signal),
  bindings: () => request<WebfleetBinding[]>('bindings', 'GET'),
  bind: (input: { objectUid: string; vehicleId: string; objectNo?: string; licensePlate?: string }) => request<WebfleetBinding[]>('bindings', 'POST', input),
  unbind: (vehicleId: string) => request<WebfleetBinding[]>(`bindings/${encodeURIComponent(vehicleId)}`, 'DELETE')
}
