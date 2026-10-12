import { CheckCircle2, MapPin, Plus, Save, Trash2 } from 'lucide-react'
import type { FormEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import type { CreateTourStopInput, GeocodeResult, StopType, Tour } from '../types/domain'

interface StopDraft {
  id: string
  type: StopType
  company: string
  address: string
  city: string
  appointmentAt: string
  serviceMinMinutes: number
  serviceMaxMinutes: number
  geocode?: GeocodeResult
  geocodeError?: string
}

export function EditTourPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const vehicles = usePolling(api.vehicles, 30_000)
  const [tour, setTour] = useState<Tour | null>(null)
  const [vehicleId, setVehicleId] = useState('')
  const [orderNumber, setOrderNumber] = useState('')
  const [stops, setStops] = useState<StopDraft[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [geocodingStopId, setGeocodingStopId] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const geocodeGeneration = useRef(new Map<string, number>())

  useEffect(() => {
    let active = true
    setLoading(true)
    api.tour(id)
      .then((loaded) => {
        if (!active) return
        setTour(loaded)
        setVehicleId(loaded.vehicleId)
        setOrderNumber(loaded.orderNumber)
        setStops(
          (loaded.stops ?? []).map((stop) => ({
            id: stop.id,
            type: stop.type,
            company: stop.company ?? '',
            address: stop.address,
            city: stop.city ?? '',
            appointmentAt: toDateTimeLocal(stop.appointmentAt),
            serviceMinMinutes: stop.serviceMinMinutes ?? 60,
            serviceMaxMinutes: stop.serviceMaxMinutes ?? 120,
            geocode: {
              address: stop.address,
              latitude: stop.latitude,
              longitude: stop.longitude,
              provider: 'saved'
            }
          }))
        )
      })
      .catch((cause) => active && setError(cause as Error))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [id])

  const canSubmit = useMemo(
    () => Boolean(vehicleId && orderNumber.trim() && stops.length >= 2 && stops.every((stop) =>
      stop.geocode
      && stop.serviceMinMinutes >= 0
      && stop.serviceMaxMinutes >= stop.serviceMinMinutes
    )),
    [orderNumber, stops, vehicleId]
  )

  function updateStop(stopId: string, patch: Partial<StopDraft>) {
    if (patch.address !== undefined) geocodeGeneration.current.set(stopId, (geocodeGeneration.current.get(stopId) ?? 0) + 1)
    setStops((current) =>
      current.map((stop) =>
        stop.id === stopId
          ? { ...stop, ...patch, geocode: patch.address !== undefined ? undefined : stop.geocode, geocodeError: undefined }
          : stop
      )
    )
  }

  function addStop(type: StopType) {
    setStops((current) => [
      ...current,
      { id: crypto.randomUUID(), type, company: '', address: '', city: '', appointmentAt: '', serviceMinMinutes: 60, serviceMaxMinutes: 120 }
    ])
  }

  async function handleGeocode(stopId: string) {
    const stop = stops.find((item) => item.id === stopId)
    if (!stop?.address.trim()) return
    const generation = (geocodeGeneration.current.get(stopId) ?? 0) + 1
    geocodeGeneration.current.set(stopId, generation)
    setGeocodingStopId(stopId)
    setError(null)
    try {
      const result = await api.geocode(stop.address.trim())
      if (geocodeGeneration.current.get(stopId) !== generation) return
      setStops((current) => current.map((item) => (item.id === stopId && item.address === stop.address ? { ...item, geocode: result } : item)))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Адрес не найден.'
      if (geocodeGeneration.current.get(stopId) !== generation) return
      setStops((current) => current.map((item) => (item.id === stopId ? { ...item, geocodeError: message } : item)))
    } finally {
      setGeocodingStopId(null)
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await api.updateTour(id, {
        vehicleId,
        orderNumber: orderNumber.trim(),
        stops: stops.map((stop, index): CreateTourStopInput => ({
          sequence: index + 1,
          type: stop.type,
          company: stop.company.trim() || undefined,
          address: stop.geocode!.address,
          city: stop.city.trim() || undefined,
          latitude: stop.geocode!.latitude,
          longitude: stop.geocode!.longitude,
          appointmentAt: stop.appointmentAt ? new Date(stop.appointmentAt).toISOString() : null,
          serviceMinMinutes: stop.serviceMinMinutes,
          serviceMaxMinutes: stop.serviceMaxMinutes
        }))
      })
      navigate('/tours')
    } catch (cause) {
      setError(cause as Error)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading || (vehicles.loading && !vehicles.data)) return <LoadingState label="План маршрута загружается" />
  if (error && !tour) return <ErrorState error={error} />
  if (!tour) return <ErrorState error={new Error('Маршрут не найден.')} />

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <div>
        <h2 className="text-xl font-semibold">Изменить маршрут</h2>
        <p className="text-sm text-slate-500">Можно изменять только будущие маршруты в очереди без подтверждённых событий.</p>
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="grid gap-4 md:grid-cols-[220px_1fr]">
          <label>
            <span className="field-label">Грузовик</span>
            <select className="field-input" value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} required>
              {vehicles.data?.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicleNumber}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">Номер заказа</span>
            <input className="field-input" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} required />
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <h3 className="font-semibold">Будущие точки</h3>
            <p className="text-sm text-slate-500">Повторно проверьте изменённые адреса перед сохранением. Сроки необязательны.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="secondary-button" onClick={() => addStop('LOAD')}><Plus className="h-4 w-4" /> Добавить загрузку</button>
            <button type="button" className="secondary-button" onClick={() => addStop('UNLOAD')}><Plus className="h-4 w-4" /> Добавить выгрузку</button>
          </div>
        </div>
        <div className="divide-y divide-slate-100">
          {stops.map((stop, index) => (
            <div key={stop.id} className="grid gap-3 px-4 py-4 xl:grid-cols-[72px_130px_1fr_1fr_170px_150px_120px_120px_44px]">
              <div><span className="field-label">№</span><div className="flex h-10 items-center text-lg font-bold">{index + 1}</div></div>
              <label><span className="field-label">Тип</span><select className="field-input" value={stop.type} onChange={(event) => updateStop(stop.id, { type: event.target.value as StopType })}><option value="LOAD">Загрузка</option><option value="UNLOAD">Выгрузка</option></select></label>
              <label><span className="field-label">Компания</span><input className="field-input" value={stop.company} onChange={(event) => updateStop(stop.id, { company: event.target.value })} /></label>
              <label><span className="field-label">Адрес</span><input className="field-input" value={stop.address} onChange={(event) => updateStop(stop.id, { address: event.target.value })} required /></label>
              <label><span className="field-label">Город</span><input className="field-input" value={stop.city} onChange={(event) => updateStop(stop.id, { city: event.target.value })} placeholder="Город неизвестен" /></label>
              <label><span className="field-label">Срок</span><input className="field-input" type="datetime-local" value={stop.appointmentAt} onChange={(event) => updateStop(stop.id, { appointmentAt: event.target.value })} /></label>
              <label><span className="field-label">Стоянка мин.</span><input className="field-input" type="number" min={0} step={5} value={stop.serviceMinMinutes} onChange={(event) => updateStop(stop.id, { serviceMinMinutes: Number(event.target.value) })} /></label>
              <label><span className="field-label">Стоянка макс.</span><input className="field-input" type="number" min={0} step={5} value={stop.serviceMaxMinutes} onChange={(event) => updateStop(stop.id, { serviceMaxMinutes: Number(event.target.value) })} /></label>
              <div><span className="field-label">Координаты</span><button type="button" className="secondary-button w-full" onClick={() => void handleGeocode(stop.id)} disabled={!stop.address.trim() || geocodingStopId === stop.id}><MapPin className="h-4 w-4" /> Проверить</button></div>
              <div className="flex items-end"><button type="button" className="danger-button min-h-10 px-2" onClick={() => setStops((current) => current.filter((item) => item.id !== stop.id))} disabled={stops.length <= 2} aria-label="Удалить точку"><Trash2 className="h-4 w-4" /></button></div>
              <div className="xl:col-start-3 xl:col-end-10">
                {stop.geocode ? <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />{stop.geocode.address} · {stop.geocode.latitude.toFixed(5)}, {stop.geocode.longitude.toFixed(5)}</div> : stop.geocodeError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{stop.geocodeError}</div> : <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">Проверьте адрес повторно.</div>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {error ? <ErrorState error={error} /> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="secondary-button" onClick={() => navigate('/tours')}>Отмена</button>
        <button className="primary-button" disabled={!canSubmit || submitting}><Save className="h-4 w-4" /> Сохранить изменения</button>
      </div>
    </form>
  )
}

function toDateTimeLocal(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}
