import { useState } from 'react'
import { formatDateTime, formatDurationMinutes, metersToKm } from '../lib/format'
import type { Stop, Tour } from '../types/domain'
import { localDateTime, operationsRequest } from './VehicleOperationsPanel'

interface DraftStop { id?: string; type: 'LOAD' | 'UNLOAD'; address: string; city?: string | null; company?: string | null; appointmentAt?: string | null; serviceMinMinutes?: number; serviceMaxMinutes?: number; latitude?: number; longitude?: number; arrivedAt?: string | null }
interface Summary { distanceMeters: number; durationSeconds: number; roads: string[]; etaWindows?: { stopId: string; earliest: string; latest: string }[] }
interface Preview { id: string; version: number; expiresAt: string; before: Summary; after: Summary; affectedTourIds: string[] }
const draft = (stop: Stop): DraftStop => ({ ...stop, serviceMinMinutes: stop.serviceMinMinutes ?? 60, serviceMaxMinutes: stop.serviceMaxMinutes ?? 120 })

export function RouteEditor({ tour, onChange }: { tour: Tour; onChange: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  const [stops, setStops] = useState<DraftStop[]>([])
  const [version, setVersion] = useState(0)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [origin, setOrigin] = useState({ latitude: '', longitude: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function start() {
    setBusy(true); setError('')
    try { const fresh = await operationsRequest<Tour & { planVersion: number }>(`/tours/${tour.id}`); setStops((fresh.stops ?? []).filter(stop => !stop.completedAt).map(draft)); setVersion(fresh.planVersion); setPreview(null); setOpen(true) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  function change(index: number, patch: Partial<DraftStop>) { setPreview(null); setStops(previous => previous.map((stop, i) => i === index ? { ...stop, ...patch } : stop)) }
  function move(index: number, direction: number) { setPreview(null); setStops(previous => { const result = [...previous]; [result[index], result[index + direction]] = [result[index + direction], result[index]]; return result }) }
  async function calculate() {
    setBusy(true); setError(''); setPreview(null)
    try {
      const result = await operationsRequest<Preview>(`/tours/${tour.id}/replan/preview`, 'POST', { version, futureStops: stops.map(stop => ({ id: stop.id, type: stop.type, address: stop.address, city: stop.city, company: stop.company, appointmentAt: stop.appointmentAt, serviceMinMinutes: stop.serviceMinMinutes, serviceMaxMinutes: stop.serviceMaxMinutes, latitude: stop.latitude, longitude: stop.longitude })), ...(origin.latitude || origin.longitude ? { origin: { latitude: Number(origin.latitude), longitude: Number(origin.longitude) } } : {}) })
      setPreview(result)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function apply() {
    if (!preview) return
    setBusy(true); setError('')
    try { await operationsRequest(`/tours/${tour.id}/replan/apply`, 'POST', { previewId: preview.id, version }); setOpen(false); await onChange() }
    catch (e) { setError((e as Error).message); setPreview(null) } finally { setBusy(false) }
  }
  return <section className="rounded-lg border border-slate-200 bg-white p-4">
    <button className="secondary-button" disabled={busy} onClick={() => open ? setOpen(false) : void start()}>{open ? 'Закрыть редактирование' : 'Изменить маршрут'}</button>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    {open && <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); void calculate() }}>
      <p className="text-sm text-slate-600">Можно менять только будущие точки. Подтверждённые прибытия и завершённые точки сохраняются. Изменения вступят в силу после предварительного расчёта и подтверждения.</p>
      {stops.map((stop, index) => <fieldset key={stop.id ?? `new-${index}`} className="space-y-2 rounded border p-3" disabled={busy || Boolean(stop.arrivedAt)}>
        <legend className="px-1 text-sm font-semibold">Точка {index + 1}{stop.arrivedAt ? ' · прибытие подтверждено (изменение запрещено)' : ''}</legend>
        <label className="block text-sm">Тип<select className="input" value={stop.type} onChange={e => change(index, { type: e.target.value as DraftStop['type'] })}><option value="LOAD">Загрузка</option><option value="UNLOAD">Выгрузка</option></select></label>
        <label className="block text-sm">Адрес<input className="input" required value={stop.address} onChange={e => change(index, { address: e.target.value, latitude: undefined, longitude: undefined })} /></label>
        <label className="block text-sm">Город<input className="input" value={stop.city ?? ''} onChange={e => change(index, { city: e.target.value })} /></label>
        <label className="block text-sm">Срок (необязательно)<input className="input" type="datetime-local" value={stop.appointmentAt ? localDateTime(stop.appointmentAt) : ''} onChange={e => change(index, { appointmentAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></label>
        <div className="grid grid-cols-2 gap-2"><label className="text-sm">Стоянка, минимум<input className="input" type="number" min="0" required value={stop.serviceMinMinutes} onChange={e => change(index, { serviceMinMinutes: Number(e.target.value) })} /></label><label className="text-sm">Стоянка, максимум<input className="input" type="number" min={stop.serviceMinMinutes} required value={stop.serviceMaxMinutes} onChange={e => change(index, { serviceMaxMinutes: Number(e.target.value) })} /></label></div>
        <div className="flex gap-2"><button type="button" className="secondary-button" disabled={index === 0 || Boolean(stops[index - 1]?.arrivedAt)} onClick={() => move(index, -1)} aria-label={`Переместить точку ${index + 1} вверх`}>↑</button><button type="button" className="secondary-button" disabled={index === stops.length - 1 || Boolean(stops[index + 1]?.arrivedAt)} onClick={() => move(index, 1)} aria-label={`Переместить точку ${index + 1} вниз`}>↓</button><button type="button" className="secondary-button" onClick={() => { setStops(previous => previous.filter((_, i) => i !== index)); setPreview(null) }}>Удалить</button></div>
      </fieldset>)}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { setStops(previous => [...previous, { type: 'UNLOAD', address: '', appointmentAt: null, serviceMinMinutes: 60, serviceMaxMinutes: 120 }]); setPreview(null) }}>Добавить точку</button>
      <details><summary className="cursor-pointer text-sm">Исправить расчётную исходную позицию</summary><p className="my-2 text-xs">GPS отсутствует. Заполняйте только при известной текущей позиции.</p><div className="grid grid-cols-2 gap-2">{(['latitude', 'longitude'] as const).map(key => <label key={key} className="text-sm">{key === 'latitude' ? 'Широта' : 'Долгота'}<input type="number" className="input" step="any" min={key === 'latitude' ? -90 : -180} max={key === 'latitude' ? 90 : 180} required={Boolean(origin.latitude || origin.longitude)} value={origin[key]} onChange={e => { setOrigin(previous => ({ ...previous, [key]: e.target.value })); setPreview(null) }} /></label>)}</div></details>
      <button className="primary-button" disabled={busy || !stops.length}>Рассчитать изменения</button>
      {preview && <div className="space-y-2 rounded bg-slate-50 p-3 text-sm"><p>Расстояние: {metersToKm(preview.before.distanceMeters)} → {metersToKm(preview.after.distanceMeters)}</p><p>Время маршрута: {formatDurationMinutes(preview.before.durationSeconds / 60)} → {formatDurationMinutes(preview.after.durationSeconds / 60)}</p><p>Текущие дороги: {preview.before.roads.join(' → ') || 'Нет данных'}</p><p>Новые дороги: {preview.after.roads.join(' → ') || 'Нет данных'}</p>{preview.after.etaWindows?.map((window, index) => { const old = preview.before.etaWindows?.find(item => item.stopId === window.stopId); const stop = stops.find(item => item.id === window.stopId); return <div className="border-t pt-2" key={window.stopId}><p className="font-medium">{stop?.city || stop?.address || `Следующая точка ${index + 1}`}</p><p>Было: {old ? `${formatDateTime(old.earliest)}–${formatDateTime(old.latest)}` : 'Новая позиция'}</p><p>Новая ETA: {formatDateTime(window.earliest)}–{formatDateTime(window.latest)}</p></div> })}<p>Затронуто заказов: {preview.affectedTourIds.length}. Расчёт действителен до {formatDateTime(preview.expiresAt)}.</p><button type="button" className="primary-button" disabled={busy || Date.parse(preview.expiresAt) <= Date.now()} onClick={() => void apply()}>Применить изменения</button></div>}
    </form>}
  </section>
}
