import { AlertTriangle, CheckCircle2, FileText, MapPin, Plus, Save, Sparkles, Trash2, Upload } from 'lucide-react'
import type { ChangeEvent, FormEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import { statusLabel } from '../lib/format'
import type { CreateTourStopInput, GeocodeResult, ImportedOrderDraft, OrderImportPreview, StopType } from '../types/domain'

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

const initialStops: StopDraft[] = [
  { id: crypto.randomUUID(), type: 'LOAD', company: '', address: '', city: '', appointmentAt: '', serviceMinMinutes: 60, serviceMaxMinutes: 120 },
  { id: crypto.randomUUID(), type: 'UNLOAD', company: '', address: '', city: '', appointmentAt: '', serviceMinMinutes: 60, serviceMaxMinutes: 120 }
]

export function NewOrderPage() {
  const navigate = useNavigate()
  const vehicles = usePolling(api.vehicles, 30_000)
  const [vehicleId, setVehicleId] = useState('')
  const [orderNumber, setOrderNumber] = useState('')
  const [stops, setStops] = useState<StopDraft[]>(initialStops)
  const [submitting, setSubmitting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importPreview, setImportPreview] = useState<OrderImportPreview | null>(null)
  const [selectedDraftIndex, setSelectedDraftIndex] = useState(0)
  const [previewVehicleId, setPreviewVehicleId] = useState('')
  const importGeneration = useRef(0)
  const geocodeGeneration = useRef(new Map<string, number>())
  const [geocodingStopId, setGeocodingStopId] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const selectedVehicle = vehicles.data?.find((vehicle) => vehicle.id === vehicleId)
  const allStopsConfirmed = stops.every((stop) =>
    stop.address.trim()
    && stop.geocode
    && stop.serviceMinMinutes >= 0
    && stop.serviceMaxMinutes >= stop.serviceMinMinutes
  )
  const canSubmit = Boolean(vehicleId && orderNumber.trim() && allStopsConfirmed && stops.length >= 2 && !importing)
  const importWarnings = importPreview
    ? [...importPreview.warnings, ...(importPreview.drafts[selectedDraftIndex]?.warnings ?? [])]
    : []
  const selectedImportDraft = importPreview?.drafts[selectedDraftIndex]

  useEffect(() => () => { importGeneration.current += 1 }, [])

  const sequenceHint = useMemo(() => {
    if (!selectedVehicle) return null
    return `Грузовик ${selectedVehicle.vehicleNumber}: новый маршрут будет создан как активный или поставлен в очередь.`
  }, [selectedVehicle])

  async function handleGeocode(stopId: string) {
    const stop = stops.find((item) => item.id === stopId)
    if (!stop?.address.trim()) return
    setError(null)
    await geocodeStop(stop, importGeneration.current)
  }

  async function geocodeStop(stop: StopDraft, generation: number) {
    const stopId = stop.id
    const requestNumber = (geocodeGeneration.current.get(stopId) ?? 0) + 1
    geocodeGeneration.current.set(stopId, requestNumber)
    const isCurrent = () => generation === importGeneration.current
      && geocodeGeneration.current.get(stopId) === requestNumber
    setGeocodingStopId(stopId)
    setStops((current) => current.map((item) => (item.id === stopId ? { ...item, geocodeError: undefined, geocode: undefined } : item)))
    try {
      const result = await api.geocode(stop.address.trim())
      if (isCurrent()) setStops((current) => current.map((item) => (item.id === stopId && item.address === stop.address ? { ...item, geocode: result } : item)))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Адрес не найден.'
      if (isCurrent()) setStops((current) => current.map((item) => (item.id === stopId && item.address === stop.address ? { ...item, geocodeError: message } : item)))
    } finally {
      setGeocodingStopId((current) => current === stopId ? null : current)
    }
  }

  async function geocodeImportedStops(importedStops: StopDraft[], generation: number) {
    for (const stop of importedStops) {
      if (generation !== importGeneration.current) return
      if (!stop.address.trim()) continue
      await geocodeStop(stop, generation)
    }
  }

  function findVehicleId(draft: ImportedOrderDraft): string {
    if (!draft.vehicleNumber || !vehicles.data) return ''
    const requestedVehicle = draft.vehicleNumber.trim().toLocaleLowerCase()
    return vehicles.data.find((vehicle) =>
      vehicle.vehicleNumber.toLocaleLowerCase() === requestedVehicle
      || vehicle.licensePlate?.toLocaleLowerCase() === requestedVehicle
    )?.id ?? ''
  }

  function selectImportedDraft(index: number) {
    const draft = importPreview?.drafts[index]
    if (!draft) return
    setSelectedDraftIndex(index)
    setPreviewVehicleId(findVehicleId(draft))
    setError(null)
    setSuccessMessage(null)
  }

  function applyImportedDraft() {
    const draft = importPreview?.drafts[selectedDraftIndex]
    if (!draft) return
    if (!previewVehicleId) {
      setError(new Error('Сначала выберите грузовик, для которого создаётся этот заказ.'))
      return
    }

    const generation = ++importGeneration.current
    setError(null)
    const importedStops: StopDraft[] = draft.stops.slice().sort((a, b) => a.sequence - b.sequence).map((stop) => ({
      id: crypto.randomUUID(),
      type: stop.type,
      company: stop.company ?? '',
      address: stop.address ?? '',
      city: '',
      appointmentAt: stop.appointmentLocal ?? '',
      serviceMinMinutes: 60,
      serviceMaxMinutes: 120
    }))

    setOrderNumber(draft.orderNumber ?? '')
    setVehicleId(previewVehicleId)
    const missingStop: StopDraft = {
      id: crypto.randomUUID(), type: importedStops[0]?.type === 'LOAD' ? 'UNLOAD' : 'LOAD',
      company: '', address: '', city: '', appointmentAt: '', serviceMinMinutes: 60, serviceMaxMinutes: 120
    }
    setStops(importedStops.length >= 2 ? importedStops : importedStops[0]?.type === 'UNLOAD'
      ? [missingStop, ...importedStops] : [...importedStops, missingStop])
    setSuccessMessage(`Предпросмотр PDF перенесён: ${draft.stops.length} точек. Проверьте распознанные данные и адреса перед сохранением заказа.`)
    void geocodeImportedStops(importedStops, generation)
  }

  async function handlePdfImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setError(null)
    setSuccessMessage(null)
    setImportPreview(null)
    setPreviewVehicleId('')
    if (!file.name.toLocaleLowerCase().endsWith('.pdf')) {
      setError(new Error('Выберите заказ только в формате PDF.'))
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setError(new Error('Размер PDF-заказа не должен превышать 20 МБ.'))
      return
    }

    setImporting(true)
    try {
      const preview = await api.importPdf(file)
      setImportPreview(preview)
      setSelectedDraftIndex(0)
      if (!preview.drafts.length) {
        setError(new Error('В PDF не найдены адреса загрузки или выгрузки. Проверьте заказ или введите данные вручную.'))
        return
      }
      setPreviewVehicleId(findVehicleId(preview.drafts[0]))
      setSuccessMessage('PDF-заказ прочитан. Подтвердите данные и грузовик; пока ничего не сохранено.')
    } catch (err) {
      setError(err as Error)
    } finally {
      setImporting(false)
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSuccessMessage(null)

    if (!canSubmit) {
      setError(new Error('Проверьте грузовик, номер заказа, время обслуживания и все подтверждённые адреса. Сроки можно оставить пустыми.'))
      return
    }

    const payload = {
      vehicleId,
      orderNumber: orderNumber.trim(),
      stops: stops.map((stop, index): CreateTourStopInput => ({
        sequence: index + 1,
        type: stop.type,
          company: stop.company.trim() || undefined,
          address: stop.geocode?.address || stop.address.trim(),
          city: stop.city.trim() || undefined,
          latitude: stop.geocode!.latitude,
          longitude: stop.geocode!.longitude,
          appointmentAt: stop.appointmentAt ? new Date(stop.appointmentAt).toISOString() : null,
          serviceMinMinutes: stop.serviceMinMinutes,
          serviceMaxMinutes: stop.serviceMaxMinutes
      }))
    }

    setSubmitting(true)
    try {
      const tour = await api.createTour(payload)
      setSuccessMessage(`Заказ ${tour.orderNumber} сохранён. Статус: ${statusLabel(tour.status)}`)
      navigate(`/vehicles/${tour.vehicleId}`)
    } catch (err) {
      setError(err as Error)
    } finally {
      setSubmitting(false)
    }
  }

  function updateStop(stopId: string, patch: Partial<StopDraft>) {
    if (patch.address !== undefined) {
      geocodeGeneration.current.set(stopId, (geocodeGeneration.current.get(stopId) ?? 0) + 1)
    }
    setStops((current) =>
      current.map((stop) =>
        stop.id === stopId
          ? {
              ...stop,
              ...patch,
              geocode: patch.address !== undefined && patch.address !== stop.address ? undefined : stop.geocode,
              geocodeError: undefined
            }
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

  function removeStop(stopId: string) {
    setStops((current) => (current.length <= 2 ? current : current.filter((stop) => stop.id !== stopId)))
  }

  if (vehicles.loading && !vehicles.data) return <LoadingState label="Грузовики загружаются" />
  if (vehicles.error && !vehicles.data) return <ErrorState error={vehicles.error} onRetry={vehicles.refetch} />

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <div>
        <h2 className="text-xl font-semibold">Новый заказ</h2>
        <p className="text-sm text-slate-500">Загрузите PDF-заказ для распознавания ИИ или введите данные вручную. Сохранение выполняется только после вашего подтверждения.</p>
      </div>

      <section className="rounded-lg border border-sky-200 bg-sky-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <FileText className="mt-0.5 h-5 w-5 text-sky-700" aria-hidden="true" />
            <div>
              <h3 className="font-semibold text-sky-950">Распознать PDF-заказ с помощью ИИ</h3>
              <p className="text-sm text-sky-800">
                Только PDF до 20 МБ. Содержимое отправляется в OpenAI для распознавания; исходный файл не сохраняется. ИИ определяет номер заказа, грузовик, точки загрузки и выгрузки, а также указанные сроки.
              </p>
              <p className="mt-1 text-xs text-sky-800">Результат является предварительным. Вы выбираете грузовик и подтверждаете данные перед переносом в форму заказа.</p>
            </div>
          </div>
          <label className={`primary-button cursor-pointer focus-within:ring-2 focus-within:ring-sky-400 focus-within:ring-offset-2 ${importing ? 'pointer-events-none opacity-60' : ''}`}>
            <Upload className="h-4 w-4" aria-hidden="true" />
            {importing ? 'PDF распознаётся…' : 'Выбрать PDF'}
            <input
              className="sr-only"
              type="file"
              accept=".pdf,application/pdf"
              onChange={(event) => void handlePdfImport(event)}
              disabled={importing}
            />
          </label>
        </div>

        {importPreview ? (
          <div className="mt-4 space-y-3 border-t border-sky-200 pt-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-sky-900">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              <span>
                Распознано ИИ · заказов/записей: {importPreview.drafts.length} · ещё не сохранено
              </span>
            </div>
            {importPreview.drafts.length > 1 ? (
              <div className="flex flex-wrap gap-2" aria-label="Распознанные заказы">
                {importPreview.drafts.map((draft, index) => (
                  <button key={`${draft.orderNumber ?? 'auftrag'}-${index}`} type="button" className="secondary-button" aria-pressed={selectedDraftIndex === index} onClick={() => selectImportedDraft(index)}>
                    {draft.orderNumber || `Заказ ${index + 1}`} · точек: {draft.stops.length}
                  </button>
                ))}
              </div>
            ) : null}
            {selectedImportDraft ? (
              <div className="rounded-lg border border-sky-200 bg-white p-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <div>
                    <span className="field-label">Распознанный заказ</span>
                    <div className="font-semibold text-slate-900">{selectedImportDraft.orderNumber || 'Не распознан'}</div>
                  </div>
                  <div>
                    <span className="field-label">Распознанный грузовик</span>
                    <div className="font-semibold text-slate-900">{selectedImportDraft.vehicleNumber || 'Не указан'}</div>
                  </div>
                  <label>
                    <span className="field-label">Назначить этому грузовику</span>
                    <select className="field-input" value={previewVehicleId} onChange={(event) => setPreviewVehicleId(event.target.value)}>
                      <option value="">Выберите грузовик</option>
                      {vehicles.data?.map((vehicle) => (
                        <option key={vehicle.id} value={vehicle.id}>
                          {vehicle.vehicleNumber} {vehicle.licensePlate ? `· ${vehicle.licensePlate}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {selectedImportDraft.vehicleNumber && !findVehicleId(selectedImportDraft) ? (
                  <p className="mt-2 text-sm text-amber-800">Распознанный в PDF грузовик «{selectedImportDraft.vehicleNumber}» не найден однозначно. Выберите нужную машину.</p>
                ) : null}

                <div className="mt-4 space-y-2">
                  {selectedImportDraft.stops.slice().sort((a, b) => a.sequence - b.sequence).map((stop, index) => (
                    <div key={`${stop.sequence}-${stop.type}-${index}`} className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm md:grid-cols-[100px_1fr_190px_120px]">
                      <div className="font-semibold text-slate-900">{stop.type === 'LOAD' ? 'Загрузка' : 'Выгрузка'} {index + 1}</div>
                      <div>
                        <div className="font-medium text-slate-900">{stop.address || 'Адрес не распознан'}</div>
                        {stop.company ? <div className="text-slate-500">{stop.company}</div> : null}
                      </div>
                      <div>{stop.appointmentLocal ? stop.appointmentLocal.replace('T', ' ') : 'Без срока'}</div>
                      <div className="text-slate-500">
                        {stop.sourcePage ? `Страница ${stop.sourcePage} · ` : ''}{Math.round(stop.confidence * 100)} %
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-slate-500">После переноса адреса будут геокодированы. Заказ и маршрут создаются только после нажатия «Сохранить заказ».</p>
                  <button type="button" className="primary-button" disabled={!previewVehicleId} onClick={applyImportedDraft}>
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    Перенести для грузовика и проверить
                  </button>
                </div>
              </div>
            ) : null}
            {importWarnings.length ? (
              <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {importWarnings.map((warning, index) => (
                  <div key={`${warning.code}-${warning.row ?? 0}-${index}`} className="flex gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{warning.page ? `Страница ${warning.page}: ` : warning.row ? `Строка ${warning.row}: ` : ''}{warning.message}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {vehicles.data?.length ? (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid gap-4 md:grid-cols-[220px_1fr]">
            <label>
              <span className="field-label">Грузовик</span>
              <select className="field-input" value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} required>
                <option value="">Выберите</option>
                {vehicles.data.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.vehicleNumber} {vehicle.licensePlate ? `· ${vehicle.licensePlate}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">Номер заказа</span>
              <input className="field-input" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} required />
            </label>
          </div>
          {sequenceHint ? <p className="mt-3 text-sm font-medium text-sky-800">{sequenceHint}</p> : null}
        </section>
      ) : (
        <EmptyState label="Нет доступных грузовиков. Сначала добавьте грузовик на странице «Грузовики»." />
      )}

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <h3 className="font-semibold">Точки маршрута</h3>
            <p className="text-sm text-slate-500">Введите адрес, выполните геокодирование и проверьте город. Сроки необязательны.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="secondary-button" onClick={() => addStop('LOAD')}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Добавить загрузку
            </button>
            <button type="button" className="secondary-button" onClick={() => addStop('UNLOAD')}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Добавить выгрузку
            </button>
          </div>
        </div>
        <div className="divide-y divide-slate-100">
          {stops.map((stop, index) => (
            <div key={stop.id} className="grid gap-3 px-4 py-4 xl:grid-cols-[72px_130px_1fr_1fr_170px_150px_120px_120px_44px]">
              <div>
                <span className="field-label">№</span>
                <div className="flex h-10 items-center text-lg font-bold tabular-nums">{index + 1}</div>
              </div>
              <label>
                <span className="field-label">Тип</span>
                <select className="field-input" value={stop.type} onChange={(event) => updateStop(stop.id, { type: event.target.value as StopType })}>
                  <option value="LOAD">Загрузка</option>
                  <option value="UNLOAD">Выгрузка</option>
                </select>
              </label>
              <label>
                <span className="field-label">Компания</span>
                <input className="field-input" value={stop.company} onChange={(event) => updateStop(stop.id, { company: event.target.value })} />
              </label>
              <label>
                <span className="field-label">Адрес</span>
                <input className="field-input" value={stop.address} onChange={(event) => updateStop(stop.id, { address: event.target.value })} required />
              </label>
              <label>
                <span className="field-label">Город</span>
                <input className="field-input" value={stop.city} onChange={(event) => updateStop(stop.id, { city: event.target.value })} placeholder="Город неизвестен" />
              </label>
              <label>
                <span className="field-label">Срок</span>
                <input className="field-input" type="datetime-local" value={stop.appointmentAt} onChange={(event) => updateStop(stop.id, { appointmentAt: event.target.value })} />
              </label>
              <label>
                <span className="field-label">Стоянка мин.</span>
                <input className="field-input" type="number" min={0} step={5} value={stop.serviceMinMinutes} onChange={(event) => updateStop(stop.id, { serviceMinMinutes: Number(event.target.value) })} />
              </label>
              <label>
                <span className="field-label">Стоянка макс.</span>
                <input className="field-input" type="number" min={0} step={5} value={stop.serviceMaxMinutes} onChange={(event) => updateStop(stop.id, { serviceMaxMinutes: Number(event.target.value) })} />
              </label>
              <div>
                <span className="field-label">Координаты</span>
                <button type="button" className="secondary-button w-full" onClick={() => void handleGeocode(stop.id)} disabled={geocodingStopId === stop.id || !stop.address.trim()}>
                  <MapPin className="h-4 w-4" aria-hidden="true" />
                  Проверить
                </button>
              </div>
              <div className="flex items-end">
                <button type="button" className="danger-button min-h-10 px-2" onClick={() => removeStop(stop.id)} disabled={stops.length <= 2} aria-label="Удалить точку">
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <div className="xl:col-start-3 xl:col-end-10">
                {stop.geocode ? (
                  <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    {stop.geocode.address} · {stop.geocode.latitude.toFixed(5)}, {stop.geocode.longitude.toFixed(5)}
                  </div>
                ) : stop.geocodeError ? (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{stop.geocodeError}</div>
                ) : (
                  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
                    Адрес ещё не подтверждён. Сохранение станет доступно после проверки координат.
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {error ? <ErrorState error={error} /> : null}
      {successMessage ? <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">{successMessage}</div> : null}

      <div className="flex justify-end">
        <button className="primary-button" disabled={!canSubmit || submitting || !vehicles.data?.length}>
          <Save className="h-4 w-4" aria-hidden="true" />
          Сохранить заказ
        </button>
      </div>
    </form>
  )
}
