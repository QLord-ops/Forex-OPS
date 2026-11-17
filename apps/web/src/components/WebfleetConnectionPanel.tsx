import { Link2, RefreshCw, Unlink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AddressBookStatus } from './AddressBookStatus'

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

function feedText(feed: { checkedAt: string | null; errorCategory: string | null; providerErrorCode: number | null }) {
  if (feed.errorCategory) return `ошибка${feed.providerErrorCode != null ? ` (код ${feed.providerErrorCode})` : ''}`
  return feed.checkedAt ? new Date(feed.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'ещё не получены'
}

export function WebfleetConnectionPanel({ vehicles = [] }: { vehicles?: Vehicle[] }) {
  const { data, error, loading, refetch } = usePolling(webfleetApi.status, 30_000)
  const bindings = usePolling(webfleetApi.bindings, 60_000)
  const suggestions = usePolling(webfleetApi.suggestions, 60_000)
  // Both roles connect trucks (owner decision 2026-11-06); the server checks it too.
  const isAdmin = currentDispatcherRole() === 'admin' || currentDispatcherRole() === 'dispatcher'
  const [selection, setSelection] = useState<Record<string, string>>({})
  const [bindingBusy, setBindingBusy] = useState<string | null>(null)
  const [bindingError, setBindingError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  async function changeBinding(key: string, action: () => Promise<unknown>) {
    setBindingBusy(key)
    setBindingError(null)
    try {
      await action()
      await Promise.all([refetch(), bindings.refetch(), suggestions.refetch()])
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

  const statusText = !data ? 'Статус не получен' : !data.configured ? 'Не настроено' : providerFailed || error || syncError ? 'Ошибка подключения' : !validSync ? 'Ожидает первой синхронизации' : stale ? 'Данные устарели' : 'Данные получены'
  const tone = healthy ? 'ok' : providerFailed || error || syncError ? 'error' : 'warn'
  const suggested = suggestions.data?.length ?? 0
  const matchLabel = [suggested ? `${suggested} предложено` : null, summary.unmatched.length ? `${summary.unmatched.length} без машины` : null].filter(Boolean).join(' · ')

  return (
    <section className="work-surface webfleet-panel" aria-label="Подключение Webfleet">
      <div className="webfleet-bar">
        <p className="webfleet-state"><span className={`webfleet-dot webfleet-dot-${tone}`} aria-hidden="true" />Webfleet: {statusText.toLocaleLowerCase('ru')}</p>
        {data?.configured ? <p className="webfleet-facts" aria-live="polite">
          {validSync ? `сводка ${validSync.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'синхронизации ещё не было'}
          {data.details ? ` · тахограф ${feedText(data.details.drivingTimes)}` : ''} · только чтение, раз в {data.pollingIntervalSeconds} сек
          {summary.received !== null ? <span> · {summary.received} объектов, {bindings.data?.length ?? summary.matched ?? '—'} привязаны к машинам OPS</span> : null}
        </p> : null}
        <div className="webfleet-actions">
          {data?.configured ? <button type="button" className="secondary-button" aria-expanded={open} aria-controls="webfleet-details" onClick={() => setOpen((value) => !value)}>
            Сопоставление{matchLabel ? <span className={summary.unmatched.length || suggested ? 'webfleet-count' : undefined}> · {matchLabel}</span> : null}
          </button> : null}
          {data?.configured ? <button type="button" className="secondary-button" onClick={() => void sync()} disabled={syncing}>
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
            {syncing ? 'Проверяем…' : 'Проверить подключение'}
          </button> : <button type="button" className="secondary-button" disabled={loading} onClick={() => void refetch()}>{loading ? 'Получаем статус…' : 'Обновить статус'}</button>}
        </div>
      </div>

      {stale && data?.configured ? <p className="webfleet-warning">Актуальная позиция не подтверждена. Сохранённые координаты могут быть устаревшими.</p> : null}
      {providerFailed ? <p className="webfleet-error">{failureText}{validRetryAfter ? ` Следующая автоматическая попытка после ${validRetryAfter.toLocaleTimeString('ru-RU')}.` : ''}</p> : null}
      {error || syncError ? <p role="alert" className="webfleet-error">{syncError || error?.message}</p> : null}
      {bindingError ? <p role="alert" className="webfleet-error">{bindingError}</p> : null}

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

      {open ? <div id="webfleet-details" className="webfleet-details">
        <p className="text-sm text-slate-600">Объекты Webfleet и машины OPS. Без машины чаще всего прицепы и машины не нашего парка; если это наша машина, выберите её номер — GPS и тахограф начнут приходить сразу. Новые машины автоматически не создаются.</p>
        {suggested ? (
          <details className="rounded-xl border border-sky-200 p-3 text-sm" open={isAdmin}>
            <summary className="cursor-pointer font-semibold text-sky-900">Предложенные привязки: {suggested}</summary>
            <p className="mt-2 text-slate-600">{isAdmin ? 'Совпадение найдено по номеру. Проверьте пару и подтвердите: автоматически ничего не привязывается.' : 'Подтвердить привязку может администратор.'}</p>
            <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
              {suggestions.data!.map(item => {
                const key = `suggest-${item.objectUid}`
                return (
                  <li key={key} className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
                    <span className="min-w-0 break-words">Webfleet {item.objectNo || item.objectUid} → LKW {item.vehicleNumber}{item.licensePlate ? ` · ${item.licensePlate}` : ''} <span className="text-xs text-slate-500">{item.reason === 'EXACT' ? 'госномер совпадает' : 'совпадают цифры номера'}</span></span>
                    {isAdmin ? (
                      <button type="button" className="secondary-button" disabled={bindingBusy !== null}
                        onClick={() => void changeBinding(key, () => webfleetApi.bind({ objectUid: item.objectUid, vehicleId: item.vehicleId, objectNo: item.objectNo || undefined }))}>
                        <Link2 className="h-4 w-4" aria-hidden="true" />
                        {bindingBusy === key ? 'Привязываем…' : 'Привязать'}
                      </button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </details>
        ) : null}

        {summary.unmatched.length > 0 ? (
          <details className="rounded-xl border border-amber-200 p-3 text-sm">
            <summary className="cursor-pointer font-semibold text-amber-900">Требуют сопоставления: {summary.unmatched.length}</summary>
            <p className="mt-2 text-slate-600">{isAdmin ? 'Выберите грузовик OPS для каждого объекта Webfleet. Привязка сохраняется и записывается в журнал аудита.' : 'Сверьте номер и госномер в карточках машин или попросите администратора привязать объект вручную.'}</p>
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

        <AddressBookStatus />
        <p className="text-xs text-slate-500">GPS не подтверждает загрузку или выгрузку сам по себе. Доступность тахографа и рабочих часов проверяется отдельно; расчётные часы машины не заменяются.</p>
      </div> : null}
    </section>
  )
}
