import { RefreshCw, Satellite } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { usePolling } from '../hooks/usePolling'
import { webfleetApi } from '../lib/webfleet-api'

function readSummary(value: unknown) {
  const summary = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const unmatched = Array.isArray(summary.unmatched) ? summary.unmatched.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    return [{
      objectUid: typeof row.objectUid === 'string' ? row.objectUid : '',
      objectNo: typeof row.objectNo === 'string' ? row.objectNo : '',
      licensePlate: typeof row.licensePlate === 'string' ? row.licensePlate : '',
      ambiguous: row.ambiguous === true
    }]
  }) : []
  return {
    matched: typeof summary.matched === 'number' ? summary.matched : null,
    received: typeof summary.received === 'number' ? summary.received : null,
    rejected: typeof summary.rejected === 'number' ? summary.rejected : 0,
    unmatched
  }
}

export function WebfleetConnectionPanel() {
  const { data, error, loading, refetch } = usePolling(webfleetApi.status, 30_000)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])

  async function sync() {
    if (controller.current) return
    const request = new AbortController()
    controller.current = request
    setSyncing(true)
    setSyncError(null)
    try {
      await webfleetApi.sync(request.signal)
      if (!request.signal.aborted) {
        await refetch()
        window.dispatchEvent(new CustomEvent('ops:data-changed'))
      }
    } catch (cause) {
      if (!request.signal.aborted) setSyncError(cause instanceof Error ? cause.message : 'Не удалось обновить данные Webfleet.')
    } finally {
      if (!request.signal.aborted) setSyncing(false)
      controller.current = null
    }
  }

  const summary = readSummary(data?.summary)
  const lastSync = data?.lastSnapshotAt ? new Date(data.lastSnapshotAt) : null
  const validSync = lastSync && Number.isFinite(lastSync.getTime()) ? lastSync : null
  const stale = validSync ? Date.now() - validSync.getTime() > 5 * 60_000 : true
  const providerFailed = data?.lastError === 'SYNC_FAILED'
  const retryAfter = data?.retryAfter ? new Date(data.retryAfter) : null
  const validRetryAfter = retryAfter && Number.isFinite(retryAfter.getTime()) ? retryAfter : null
  const healthy = Boolean(data?.configured && validSync && !stale && !providerFailed && !error && !syncError)

  return (
    <section className="work-surface space-y-3 p-4" aria-label="Подключение Webfleet">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Satellite className="h-5 w-5 shrink-0 text-sky-600" aria-hidden="true" />
          <div>
            <h3 className="font-bold text-slate-900">Webfleet</h3>
            <p className="text-sm text-slate-500">Получение телеметрии · без отправки команд в Webfleet</p>
          </div>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${healthy ? 'bg-emerald-50 text-emerald-800' : providerFailed || error || syncError ? 'bg-rose-50 text-rose-800' : 'bg-amber-50 text-amber-800'}`}>
          {!data ? 'Статус не получен' : !data.configured ? 'Не настроено' : providerFailed || error || syncError ? 'Ошибка подключения' : !validSync ? 'Ожидает первой синхронизации' : stale ? 'Данные устарели' : 'Данные получены'}
        </span>
      </div>

      {data && !data.configured ? (
        <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
          <p>Для подключения администратор должен настроить на сервере:</p>
          <ul className="mt-2 list-inside list-disc space-y-1">
            <li>Аккаунт Webfleet и отдельного пользователя с доступом WEBFLEET.connect только для чтения.</li>
            <li>Переменные WEBFLEET_ACCOUNT, WEBFLEET_USERNAME, WEBFLEET_PASSWORD и WEBFLEET_API_KEY.</li>
          </ul>
          <p className="mt-2">Пароль и ключ не вводятся в браузере и не передаются в чат.</p>
        </div>
      ) : null}

      {data?.configured ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="min-w-0 text-slate-600" aria-live="polite">
            <p>Последняя синхронизация: {validSync ? validSync.toLocaleString('ru-RU') : 'ещё не выполнялась'}</p>
            {summary.received !== null ? <p>Объектов получено: {summary.received} · Сопоставлено: {summary.matched ?? '—'}{summary.rejected ? ` · Отклонено устаревших/некорректных: ${summary.rejected}` : ''}</p> : null}
            {stale ? <p className="mt-1 text-amber-800">Актуальная позиция не подтверждена. Сохранённые координаты могут быть устаревшими.</p> : null}
            {providerFailed ? <p className="mt-1 text-rose-700">Webfleet не ответил или отклонил доступ.{validRetryAfter ? ` Следующая автоматическая попытка после ${validRetryAfter.toLocaleTimeString('ru-RU')}.` : ''}</p> : null}
            <p className="mt-1 text-xs text-slate-500">Режим: только чтение · общий снимок не чаще раза в {data.pollingIntervalSeconds} сек.</p>
          </div>
          <button type="button" className="secondary-button" onClick={() => void sync()} disabled={syncing}>
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
            {syncing ? 'Проверяем…' : 'Проверить подключение'}
          </button>
        </div>
      ) : null}

      {summary.unmatched.length > 0 ? (
        <details className="rounded-xl border border-amber-200 p-3 text-sm">
          <summary className="cursor-pointer font-semibold text-amber-900">Требуют сопоставления: {summary.unmatched.length}</summary>
          <p className="mt-2 text-slate-600">Сверьте номер и госномер в карточках машин. Новые машины автоматически не создаются.</p>
          <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
            {summary.unmatched.map((vehicle, index) => (
              <li key={`${vehicle.objectUid}-${index}`} className="break-words text-slate-700">
                {vehicle.objectNo || vehicle.objectUid || 'Без номера'}{vehicle.licensePlate ? ` · ${vehicle.licensePlate}` : ''} — {vehicle.ambiguous ? 'несколько совпадений' : 'машина не найдена'}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {error || syncError ? <p role="alert" className="text-sm text-red-700">{syncError || error?.message}</p> : null}
      {!data?.configured ? <button type="button" className="secondary-button" disabled={loading} onClick={() => void refetch()}>{loading ? 'Получаем статус…' : 'Обновить статус'}</button> : null}
      <p className="text-xs text-slate-500">GPS не подтверждает загрузку или выгрузку автоматически. Доступность тахографа и рабочих часов проверяется отдельно; расчётные часы машины не заменяются.</p>
    </section>
  )
}
