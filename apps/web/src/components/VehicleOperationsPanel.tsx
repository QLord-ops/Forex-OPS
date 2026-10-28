import { useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { formatDateTime, formatDurationMinutes, statusLabel } from '../lib/format'
import type { Stop } from '../types/domain'
import { authHeaders, notifySessionExpired } from '../lib/auth'

// Shared exclusively by the operations components in this feature.
// eslint-disable-next-line react-refresh/only-export-components
export const operationsBase = '/api'
// eslint-disable-next-line react-refresh/only-export-components
export async function operationsRequest<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${operationsBase}${path}`, { method, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...authHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) {
    if (response.status === 401) notifySessionExpired()
    const text = await response.text()
    let message = text
    try { const parsed = JSON.parse(text); message = parsed.error || parsed.message || text } catch { /* Keep plain error. */ }
    throw new Error(message || `HTTP ${response.status}`)
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

type ExceptionKind = 'EXTENDED_DRIVING' | 'REDUCED_REST' | 'BOTH'
interface Clock {
  currentCycle: { startedAt: string; drivingSeconds: number; continuousDrivingSeconds: number; dutySeconds: number; extendedDriveReservationId?: string | null; reducedRestReservationId?: string | null }
  weeklyExtendedDrive: { used: number }; reducedRestsSinceWeeklyRest: number; warnings?: string[]
}
interface Operations {
  version: number; preliminary: boolean; clock?: Clock | null; manualStoppedAt?: string | null
  position?: { status?: string; eta?: string | null; pauseKind?: string }; currentStop?: Stop | null; dwellMinutes?: number | null
  clockProposals?: { kind: ExceptionKind; ordinaryEta: string; newEta: string; gainMinutes: number; extendedRemaining: number; reducedRemaining: number }[]
  traffic?: TrafficStatus | null
}
interface TrafficStatus {
  version: number; checkedAt?: string | null; stale: boolean; ageSeconds?: number | null; providerStatus?: string; warning?: string; reason?: string; refreshIntervalSeconds?: number | null
  quota?: { used: number; limit: number; reservedForManual: number; availableForSource: number }
  activeRoute?: { roadNumbers: string[]; trafficDelaySeconds: number; hasRoadClosure: boolean }
  proposals: { reason: string; timeSavingSeconds: number; extraDistanceMeters: number; roadNumbers: string[]; route: { instructions: { message: string; exitNumber?: string }[] } }[]
}

// eslint-disable-next-line react-refresh/only-export-components
export function localDateTime(value = new Date().toISOString()) {
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

export function VehicleOperationsPanel({ vehicleId, onChange }: { vehicleId: string; onChange: () => Promise<unknown> }) {
  const state = usePolling(() => operationsRequest<Operations>(`/vehicles/${vehicleId}/operations`), 5000, Boolean(vehicleId), vehicleId)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [arrival, setArrival] = useState(localDateTime())
  const [reason, setReason] = useState('')
  const data = state.data
  async function act(path: string, method = 'POST', body: unknown = { version: data?.version }) {
    setBusy(true); setError('')
    try { await operationsRequest(path, method, body); await state.refetch(); await onChange(); setEditing(false) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const cycle = data?.clock?.currentCycle
  return <section className="work-surface min-w-0 space-y-3 p-4">
    <h3 className="font-semibold">Время грузовика и стоянка</h3>
    <p className="text-xs text-slate-500">Расчётная модель для грузовика, а не подтверждение фактического времени вождения или отдыха.</p>
    {(error || state.error) && <p role="alert" className="text-sm text-red-700">{error || state.error?.message}</p>}
    {!data && !state.error && <p>Загружается время грузовика…</p>}
    {data && <>
      {data.preliminary ? <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">Исходные часы неизвестны. ETA предварительная; исключения не предлагаются.</p> : cycle && <dl className="grid grid-cols-2 gap-3 text-sm">
        <div><dt>Осталось времени вождения</dt><dd className="font-semibold">{formatDurationMinutes(((cycle.extendedDriveReservationId ? 36000 : 32400) - cycle.drivingSeconds) / 60)}</dd></div>
        <div><dt>До 45-минутной паузы</dt><dd className="font-semibold">{formatDurationMinutes((14400 - cycle.continuousDrivingSeconds) / 60)}</dd></div>
        <div><dt>Осталось рабочего времени</dt><dd className="font-semibold">{formatDurationMinutes(((cycle.reducedRestReservationId ? 54000 : 46800) - cycle.dutySeconds) / 60)}</dd></div>
        <div><dt>Следующий отдых</dt><dd className="font-semibold">{cycle.reducedRestReservationId ? '9 ч' : '11 ч'}</dd></div>
        <div><dt>Осталось 10-часовых исключений на неделю</dt><dd>{Math.max(0, 2 - (data.clock?.weeklyExtendedDrive.used ?? 0))}</dd></div>
        <div><dt>Осталось 9-часовых отдыхов до еженедельного отдыха</dt><dd>{Math.max(0, 3 - (data.clock?.reducedRestsSinceWeeklyRest ?? 0))}</dd></div>
      </dl>}
      <p className="text-sm">Состояние: {data.currentStop?.arrivedAt ? 'Прибытие подтверждено — стоянка' : data.manualStoppedAt ? 'Остановлен вручную' : ({ BREAK: 'Расчётная пауза', DAILY_REST: 'Расчётный ночной отдых', MANUAL_STOP: 'Остановлен вручную', MOVING: 'В пути', ARRIVED: 'Ожидается прибытие (не подтверждено)', PREDICTED_ARRIVAL: 'Ожидается прибытие', WAITING: 'Ожидает', IDLE: 'Свободен' } as Record<string, string>)[data.position?.pauseKind || data.position?.status || ''] || statusLabel(data.position?.status)}</p>
      <TrafficPanel data={data} vehicleId={vehicleId} busy={busy} act={act} />
      {data.clock?.warnings?.map(warning => <p key={warning} role="alert" className="text-sm text-amber-800">{warning === 'DUTY_WINDOW_EXCEEDED_BY_STOP' ? 'Стоянка превышает рабочее время и не засчитывается как отдых.' : warning}</p>)}
      {data.currentStop && !data.currentStop.arrivedAt && <div className="space-y-2"><p className="text-sm">Подтвердите фактическое прибытие в {data.currentStop.city || data.currentStop.address}:</p><label className="block text-sm">Время прибытия<input aria-label="Время прибытия" type="datetime-local" className="input" value={arrival} onChange={e => setArrival(e.target.value)} /></label><button className="primary-button" disabled={busy || !arrival} onClick={() => void act(`/stops/${data.currentStop!.id}/arrival`, 'POST', { arrivedAt: new Date(arrival).toISOString() })}>Подтвердить прибытие</button></div>}
      {data.currentStop?.arrivedAt && <div className="rounded bg-sky-50 p-3 text-sm"><strong>Стоянка: {formatDurationMinutes(data.dwellMinutes)}</strong><p>С {formatDateTime(data.currentStop.arrivedAt)} · план {data.currentStop.serviceMinMinutes ?? 60}–{data.currentStop.serviceMaxMinutes ?? 120} мин, включая ожидание</p>{(data.dwellMinutes ?? 0) > (data.currentStop.serviceMaxMinutes ?? 120) && <p className="text-red-700">Плановое время стоянки превышено</p>}</div>}
      <div className="flex flex-wrap gap-2"><button className="secondary-button" disabled={busy} onClick={() => setEditing(!editing)}>Настроить исходные часы</button>{data.manualStoppedAt ? <button className="primary-button" disabled={busy} onClick={() => void act(`/vehicles/${vehicleId}/resume`)}>Продолжить движение</button> : <button className="secondary-button" disabled={busy || data.position?.status !== 'MOVING'} onClick={() => void act(`/vehicles/${vehicleId}/manual-stop`)}>Остановить движение</button>}</div>
      {editing && <form className="space-y-2 border-t pt-3" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void act(`/vehicles/${vehicleId}/clock`, 'PUT', { cycleStartedAt: new Date(String(form.get('cycleStartedAt'))).toISOString(), dailyDrivingMinutes: Number(form.get('dailyDrivingMinutes')), drivingSinceBreakMinutes: Number(form.get('drivingSinceBreakMinutes')), extendedDrivingUsed: Number(form.get('extendedDrivingUsed')), reducedRestUsed: Number(form.get('reducedRestUsed')), currentExtendedDriving: form.has('currentExtendedDriving'), currentReducedRest: form.has('currentReducedRest'), reason: form.get('reason'), version: data.version }) }}>
        <label className="block text-sm">Начало рабочего периода<input className="input" type="datetime-local" name="cycleStartedAt" required defaultValue={localDateTime(cycle?.startedAt)} /></label>
        {[['dailyDrivingMinutes', 'Вождение в текущем цикле, мин', 600, Math.round((cycle?.drivingSeconds ?? 0) / 60)], ['drivingSinceBreakMinutes', 'Вождение после паузы, мин', 240, Math.round((cycle?.continuousDrivingSeconds ?? 0) / 60)], ['extendedDrivingUsed', 'Использовано 10-часовых исключений за неделю', 2, data.clock?.weeklyExtendedDrive.used ?? 0], ['reducedRestUsed', 'Использовано 9-часовых отдыхов после еженедельного отдыха', 3, data.clock?.reducedRestsSinceWeeklyRest ?? 0]].map(([name, label, max, value]) => <label className="block text-sm" key={name}>{label}<input className="input" type="number" name={String(name)} min="0" max={max} required defaultValue={value} /></label>)}
        <p className="text-xs text-slate-600">Счётчики включают текущий рабочий период. Уже одобренные исключения необходимо учитывать как минимум единицей.</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="currentExtendedDriving" defaultChecked={Boolean(cycle?.extendedDriveReservationId)} />10 часов в текущем периоде уже одобрены</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="currentReducedRest" defaultChecked={Boolean(cycle?.reducedRestReservationId)} />15 часов работы / 9 часов отдыха уже одобрены</label>
        <label className="block text-sm">Причина корректировки<input className="input" name="reason" required minLength={3} /></label><button className="primary-button" disabled={busy}>Сохранить часы</button>
      </form>}
      {data.clockProposals?.map(proposal => <div key={proposal.kind} className="rounded border p-3 text-sm"><p>Обычная ETA {formatDateTime(proposal.ordinaryEta)} → {formatDateTime(proposal.newEta)} · выигрыш {formatDurationMinutes(proposal.gainMinutes)}</p><p>После применения останется: {proposal.extendedRemaining} × 10-часовое вождение / {proposal.reducedRemaining} × 9-часовой отдых</p><button className="secondary-button" disabled={busy} onClick={() => void act(`/vehicles/${vehicleId}/exceptions`, 'POST', { kind: proposal.kind, version: data.version })}>{proposal.kind === 'EXTENDED_DRIVING' ? 'Использовать 10-й час' : proposal.kind === 'REDUCED_REST' ? 'Использовать 15 часов / отдых 9 часов' : 'Использовать оба исключения'}</button></div>)}
      {(cycle?.extendedDriveReservationId || cycle?.reducedRestReservationId) && <button className="secondary-button" disabled={busy} onClick={() => void act(`/vehicles/${vehicleId}/exceptions`, 'DELETE')}>Освободить ещё не начатые исключения</button>}
      {!data.preliminary && <details><summary className="cursor-pointer text-sm">Подтвердить еженедельный отдых</summary><p className="my-2 text-xs">Подтверждайте только фактически завершённый еженедельный отдых. Счётчик сокращённых отдыхов будет сброшен.</p><label className="block text-sm">Причина / подтверждение<input className="input" value={reason} onChange={e => setReason(e.target.value)} /></label><button className="secondary-button mt-2" disabled={busy || reason.trim().length < 3} onClick={() => void act(`/vehicles/${vehicleId}/weekly-rest`, 'POST', { reason, version: data.version })}>Подтвердить завершённый еженедельный отдых</button></details>}
    </>}
  </section>
}

function TrafficPanel({ data, vehicleId, busy, act }: { data: Operations; vehicleId: string; busy: boolean; act: (path: string, method?: string, body?: unknown) => Promise<void> }) {
  const [origin, setOrigin] = useState({ latitude: '', longitude: '' })
  const traffic = data.traffic
  const validOrigin = (!origin.latitude && !origin.longitude) || (origin.latitude !== '' && origin.longitude !== '' && Math.abs(Number(origin.latitude)) <= 90 && Math.abs(Number(origin.longitude)) <= 180)
  return <div className="space-y-2 rounded bg-slate-50 p-3 text-sm">
    <p className="font-semibold">Трафик и дороги</p>
    {traffic?.providerStatus === 'live-traffic' && traffic.activeRoute ? <>
      <p>{traffic.activeRoute.roadNumbers.join(' → ') || 'Номера дорог недоступны'}</p>
      <p>Задержка: {formatDurationMinutes(traffic.activeRoute.trafficDelaySeconds / 60)} · проверено {formatDateTime(traffic.checkedAt)}</p>
      <p>Возраст данных: {formatDurationMinutes((traffic.ageSeconds ?? 0) / 60)}</p>
      {traffic.activeRoute.hasRoadClosure && <p className="text-red-700">На маршруте зарегистрировано перекрытие.</p>}
    </> : <p className="text-amber-800">Без актуальных пробок и проверки ограничений для грузовиков.</p>}
    {traffic?.stale && <p className="text-amber-800">Данные о трафике устарели или недоступны. Отсутствие обновления не означает отсутствие пробок.</p>}
    {traffic?.warning && <p>{traffic.warning}</p>}
    {traffic?.reason && <p>{traffic.reason}</p>}
    <p>Фоновые запросы выполняются только в пути. Интервал: {traffic?.refreshIntervalSeconds ? formatDurationMinutes(traffic.refreshIntervalSeconds / 60) : 'зависит от бесплатной квоты'}.</p>
    {traffic?.quota && <p>Месячная квота: {traffic.quota.used} / {traffic.quota.limit} · резерв для ручных действий: {traffic.quota.reservedForManual}</p>}
    <button className="secondary-button" disabled={busy} onClick={() => void act(`/vehicles/${vehicleId}/traffic/refresh`)}>Обновить трафик</button>
    {Boolean(traffic?.proposals?.length) && <>
      <p>Рекомендация рассчитана от предполагаемой позиции и не является GPS-командой поворота. Активный маршрут сохранится до подтверждения.</p>
      <details><summary>Уточнить позицию перед применением (необязательно)</summary><div className="grid grid-cols-2 gap-2">{(['latitude', 'longitude'] as const).map(key => <label key={key}>{key === 'latitude' ? 'Широта' : 'Долгота'}<input className="input" type="number" step="any" min={key === 'latitude' ? -90 : -180} max={key === 'latitude' ? 90 : 180} value={origin[key]} onChange={e => setOrigin(previous => ({ ...previous, [key]: e.target.value }))} /></label>)}</div></details>
      {traffic?.proposals.slice(0, 2).map((proposal, index) => <div className="space-y-1 rounded border p-2" key={`${index}-${proposal.roadNumbers.join('-')}`}><p className="font-semibold">{proposal.roadNumbers.join(' → ') || 'Дороги недоступны'}</p><p>Выигрыш {formatDurationMinutes(proposal.timeSavingSeconds / 60)} · дополнительный путь {(proposal.extraDistanceMeters / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км</p>{proposal.route.instructions.filter(instruction => instruction.exitNumber).slice(0, 3).map((instruction, i) => <p key={i}>Съезд {instruction.exitNumber}: {instruction.message}</p>)}<button className="primary-button" disabled={busy || !validOrigin} onClick={() => void act(`/vehicles/${vehicleId}/traffic/accept`, 'POST', { index, version: data.version, ...(origin.latitude && origin.longitude ? { origin: { latitude: Number(origin.latitude), longitude: Number(origin.longitude) } } : {}) })}>Проверить и применить объезд</button></div>)}
      <button className="secondary-button" disabled={busy} onClick={() => void act(`/vehicles/${vehicleId}/traffic/reject`)}>Сохранить активный маршрут</button>
    </>}
    <details><summary>Габариты и вес грузовика</summary><p className="my-2 text-xs">Укажите фактические параметры. Без них невозможно полностью проверить ограничения для грузовиков.</p><form className="space-y-2" onSubmit={e => { e.preventDefault(); const values = new FormData(e.currentTarget); const body: Record<string, unknown> = { version: data.version }; for (const [key, value] of values) body[key] = Number(value); void act(`/vehicles/${vehicleId}/truck-profile`, 'PUT', body) }}>
      {([['heightMeters', 'Высота, м'], ['widthMeters', 'Ширина, м'], ['lengthMeters', 'Длина, м'], ['weightKg', 'Общий вес, кг'], ['axleWeightKg', 'Нагрузка на ось, кг']] as const).map(([key, label]) => <label className="block" key={key}>{label}<input className="input" type="number" min="0.01" step="any" name={key} required /></label>)}<button className="secondary-button" disabled={busy}>Сохранить параметры грузовика</button>
    </form></details>
  </div>
}
