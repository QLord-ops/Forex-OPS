import { Link2, RefreshCw, Satellite, Unlink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { usePolling } from '../hooks/usePolling'
import { currentDispatcherRole } from '../lib/auth'
import { webfleetApi, webfleetErrorText } from '../lib/webfleet-api'
import type { Vehicle } from '../types/domain'

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

export function WebfleetConnectionPanel({ vehicles = [] }: { vehicles?: Vehicle[] }) {
  const { data, error, loading, refetch } = usePolling(webfleetApi.status, 30_000)
  const bindings = usePolling(webfleetApi.bindings, 60_000)
  const isAdmin = currentDispatcherRole() === 'admin'
  const [selection, setSelection] = useState<Record<string, string>>({})
  const [bindingBusy, setBindingBusy] = useState<string | null>(null)
  const [bindingError, setBindingError] = useState<string | null>(null)

  async function changeBinding(key: string, action: () => Promise<unknown>) {
    setBindingBusy(key)
    setBindingError(null)
    try {
      await action()
      await Promise.all([refetch(), bindings.refetch()])
      window.dispatchEvent(new CustomEvent('ops:data-changed'))
    } catch (cause) {
      setBindingError(cause instanceof Error ? cause.message : 'Не удалось изменить привязку.')
    } finally {
      setBindingBusy(null)
    }
  }
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
  const boundVehicleIds = new Set((bindings.data ?? []).map(binding => binding.vehicleId))
  const freeVehicles = vehicles.filter(vehicle => !boundVehicleIds.has(vehicle.id))
  const failureText = providerFailed
    ? `${webfleetErrorText[data?.errorCategory ?? 'UNKNOWN'] ?? webfleetErrorText.UNKNOWN}${data?.providerErrorCode != null ? ` Код Webfleet: ${data.providerErrorCode}.` : ''}`
    : null
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
            {providerFailed ? <p className="mt-1 text-rose-700">{failureText}{validRetryAfter ? ` Следующая автоматическая попытка после ${validRetryAfter.toLocaleTimeString('ru-RU')}.` : ''}</p> : null}
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
          <p className="mt-2 text-slate-600">{isAdmin ? 'Выберите грузовик OPS для каждого объекта Webfleet. Привязка сохраняется и записывается в журнал аудита.' : 'Сверьте номер и госномер в карточках машин или попросите администратора привязать объект вручную.'} Новые машины автоматически не создаются.</p>
          <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
            {summary.unmatched.map((object, index) => {
              const key = object.objectUid || String(index)
              const label = object.objectNo || object.objectUid || 'Без номера'
              return (
                <li key={`${key}-${index}`} className="flex flex-wrap items-center justify-between gap-2 break-words text-slate-700">
                  <span className="min-w-0">{label}{object.licensePlate ? ` · ${object.licensePlate}` : ''} — {object.ambiguous ? 'несколько совпадений' : 'машина не найдена'}</span>
                  {isAdmin && object.objectUid ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label={`Грузовик OPS для ${label}`}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm"
                        value={selection[key] ?? ''}
                        onChange={event => setSelection(current => ({ ...current, [key]: event.target.value }))}
                      >
                        <option value="">Выберите грузовик…</option>
                        {freeVehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicleNumber}{vehicle.licensePlate ? ` · ${vehicle.licensePlate}` : ''}</option>)}
                      </select>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!selection[key] || bindingBusy !== null}
                        onClick={() => void changeBinding(key, () => webfleetApi.bind({ objectUid: object.objectUid, vehicleId: selection[key], objectNo: object.objectNo || undefined, licensePlate: object.licensePlate || undefined }))}
                      >
                        <Link2 className="h-4 w-4" aria-hidden="true" />
                        {bindingBusy === key ? 'Привязываем…' : 'Привязать'}
                      </button>
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </details>
      ) : null}

      {bindings.data && bindings.data.length > 0 ? (
        <details className="rounded-xl border border-slate-200 p-3 text-sm">
          <summary className="cursor-pointer font-semibold text-slate-800">Привязанные машины: {bindings.data.length}</summary>
          <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
            {bindings.data.map(binding => (
              <li key={binding.objectUid} className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
                <span className="min-w-0 break-words">{binding.vehicleNumber}{binding.licensePlate ? ` · ${binding.licensePlate}` : ''} ↔ Webfleet {binding.objectNo || binding.objectUid}</span>
                {isAdmin ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={bindingBusy !== null}
                    onClick={() => { if (window.confirm(`Отвязать ${binding.vehicleNumber} от Webfleet? История позиций сохранится.`)) void changeBinding(`unbind-${binding.vehicleId}`, () => webfleetApi.unbind(binding.vehicleId)) }}
                  >
                    <Unlink className="h-4 w-4" aria-hidden="true" />
                    {bindingBusy === `unbind-${binding.vehicleId}` ? 'Отвязываем…' : 'Отвязать'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {bindingError ? <p role="alert" className="text-sm text-red-700">{bindingError}</p> : null}
      {error || syncError ? <p role="alert" className="text-sm text-red-700">{syncError || error?.message}</p> : null}
      {!data?.configured ? <button type="button" className="secondary-button" disabled={loading} onClick={() => void refetch()}>{loading ? 'Получаем статус…' : 'Обновить статус'}</button> : null}
      <p className="text-xs text-slate-500">GPS не подтверждает загрузку или выгрузку автоматически. Доступность тахографа и рабочих часов проверяется отдельно; расчётные часы машины не заменяются.</p>
    </section>
  )
}
