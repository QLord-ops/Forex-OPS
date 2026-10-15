import { AlertTriangle, Check, CheckCircle2, ChevronRight, Clock3, FileText, LoaderCircle, Pencil, Plus, Sparkles, Trash2, Upload } from 'lucide-react'
import type { ChangeEvent, DragEvent, FormEvent } from 'react'
import { useMemo, useRef, useState } from 'react'
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
  appointmentWindowStartAt: string
  appointmentWindowEndAt: string
  loadingMeters: string
  referenceNumbers: string
  instructions: string
  serviceMinMinutes: number
  serviceMaxMinutes: number
  sourceExcerpt?: string | null
  sourcePage?: number | null
  geocode?: GeocodeResult
  geocodeError?: string
}

type ImportFileKind = 'PDF' | 'EXCEL' | 'IMAGE' | 'UNSUPPORTED'
type ImportFileStatus = 'queued' | 'processing' | 'ready' | 'error'

interface ImportQueueItem {
  id: string
  key: string
  fileName: string
  fileType: ImportFileKind
  status: ImportFileStatus
  preview?: OrderImportPreview
  error?: string
  completedDraftIndexes: number[]
}

interface ImportSelection { itemId: string; draftIndex: number }

function createStop(type: StopType): StopDraft {
  return { id: crypto.randomUUID(), type, company: '', address: '', city: '', appointmentAt: '', appointmentWindowStartAt: '', appointmentWindowEndAt: '', loadingMeters: '', referenceNumbers: '', instructions: '', serviceMinMinutes: 60, serviceMaxMinutes: 120 }
}

function createInitialStops() { return [createStop('LOAD'), createStop('UNLOAD')] }

function classifyImportFile(file: File): ImportFileKind {
  const name = file.name.toLocaleLowerCase()
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'PDF'
  if (name.endsWith('.xlsx') || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'EXCEL'
  if (/\.(png|jpe?g|webp)$/.test(name) || ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return 'IMAGE'
  return 'UNSUPPORTED'
}

function validateImportFile(file: File) {
  const kind = classifyImportFile(file)
  if (kind === 'PDF' && file.size > 20 * 1024 * 1024) throw new Error(`PDF «${file.name}» больше 20 МБ.`)
  if (kind === 'EXCEL' && file.size > 5 * 1024 * 1024) throw new Error(`Excel «${file.name}» больше 5 МБ.`)
  if (kind === 'IMAGE' && file.size > 10 * 1024 * 1024) throw new Error(`Скриншот «${file.name}» больше 10 МБ.`)
  if (kind === 'UNSUPPORTED') throw new Error(`Файл «${file.name}» не поддерживается.`)
}

function isDraftCompleted(item: ImportQueueItem, index: number) { return item.completedDraftIndexes.includes(index) }

function findNextImportSelection(items: ImportQueueItem[], current?: ImportSelection | null): ImportSelection | null {
  for (const item of items) {
    if (item.status !== 'ready' || !item.preview) continue
    for (let index = 0; index < item.preview.drafts.length; index += 1) {
      if ((!current || current.itemId !== item.id || current.draftIndex !== index) && !isDraftCompleted(item, index)) return { itemId: item.id, draftIndex: index }
    }
  }
  return null
}

function buildStopsFromImport(draft: ImportedOrderDraft): StopDraft[] {
  const result = draft.stops.slice().sort((a, b) => a.sequence - b.sequence).map((stop): StopDraft => ({
    id: crypto.randomUUID(), type: stop.type, company: stop.company ?? '', address: stop.address ?? '', city: stop.city ?? '',
    appointmentAt: stop.appointmentLocal ?? '', appointmentWindowStartAt: stop.appointmentWindowStartLocal ?? '', appointmentWindowEndAt: stop.appointmentWindowEndLocal ?? '', loadingMeters: stop.loadingMeters?.toString() ?? '',
    referenceNumbers: stop.referenceNumbers?.join(', ') ?? '', instructions: stop.instructions ?? '', serviceMinMinutes: 60, serviceMaxMinutes: 120,
    sourceExcerpt: stop.sourceExcerpt, sourcePage: stop.sourcePage
  }))
  if (!result.length) return createInitialStops()
  if (result[0].type !== 'LOAD') result.unshift(createStop('LOAD'))
  if (!result.some((stop) => stop.type === 'UNLOAD')) result.push(createStop('UNLOAD'))
  return result
}

function buildGeocodeQuery(address: string, city: string) {
  const cleanAddress = address.trim()
  const cleanCity = city.trim()
  return !cleanCity || cleanAddress.toLocaleLowerCase().includes(cleanCity.toLocaleLowerCase()) ? cleanAddress : `${cleanAddress}, ${cleanCity}`
}

function appointmentLabel(value: string) {
  if (!value) return 'Без термина'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value.replace('T', ' ') : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function normalizeVehicleIdentifier(value: string) {
  return value.toLocaleUpperCase().replace(/^LKW\s*/i, '').replace(/[^A-Z0-9]/g, '')
}

export function NewOrderPage() {
  const navigate = useNavigate()
  const vehicles = usePolling(api.vehicles, 30_000)
  const [vehicleId, setVehicleId] = useState('')
  const [orderNumber, setOrderNumber] = useState('')
  const [createNewVehicle, setCreateNewVehicle] = useState(false)
  const [newVehicleNumber, setNewVehicleNumber] = useState('')
  const [newVehiclePlate, setNewVehiclePlate] = useState('')
  const [trailerPlate, setTrailerPlate] = useState('')
  const [tourRemarks, setTourRemarks] = useState('')
  const [stops, setStops] = useState<StopDraft[]>(createInitialStops)
  const [manualMode, setManualMode] = useState(false)
  const [editing, setEditing] = useState(false)
  const [activeStopId, setActiveStopId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [isImportDragging, setIsImportDragging] = useState(false)
  const [importItems, setImportItems] = useState<ImportQueueItem[]>([])
  const [importSelection, setImportSelection] = useState<ImportSelection | null>(null)
  const [appliedImportSelection, setAppliedImportSelection] = useState<ImportSelection | null>(null)
  const [geocodingStopIds, setGeocodingStopIds] = useState<string[]>([])
  const geocodeGeneration = useRef(new Map<string, number>())
  const [error, setError] = useState<Error | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const selectedVehicle = vehicles.data?.find((vehicle) => vehicle.id === vehicleId)
  const selectedImportItem = importItems.find((item) => item.id === importSelection?.itemId)
  const selectedImportDraft = selectedImportItem?.preview?.drafts[importSelection?.draftIndex ?? 0]
  const importWarnings = selectedImportItem?.preview ? [...selectedImportItem.preview.warnings, ...(selectedImportDraft?.warnings ?? [])] : []
  const remainingImportDrafts = importItems.reduce((total, item) => total + (item.preview?.drafts.filter((_, index) => !isDraftCompleted(item, index)).length ?? 0), 0)
  const hasOrderDraft = manualMode || Boolean(selectedImportDraft)
  const readyToConfirm = Boolean((createNewVehicle ? newVehicleNumber.trim() : vehicleId) && orderNumber.trim() && stops.length >= 2 && stops.every((stop) => stop.address.trim()))
  const sequenceHint = useMemo(() => selectedVehicle ? `LKW ${selectedVehicle.vehicleNumber}: Auftrag станет активным или будет добавлен в очередь.` : null, [selectedVehicle])

  function findVehicleId(draft: ImportedOrderDraft) {
    if (!vehicles.data) return ''
    const requested = [draft.vehicleNumber, draft.vehiclePlate].filter((value): value is string => Boolean(value)).map(normalizeVehicleIdentifier)
    const matches = vehicles.data.filter((vehicle) => [vehicle.vehicleNumber, vehicle.licensePlate].some((value) => value && requested.includes(normalizeVehicleIdentifier(value))))
    return matches.length === 1 ? matches[0].id : ''
  }

  async function geocodeStop(stop: StopDraft) {
    if (!stop.address.trim()) return
    const requestNumber = (geocodeGeneration.current.get(stop.id) ?? 0) + 1
    geocodeGeneration.current.set(stop.id, requestNumber)
    setGeocodingStopIds((current) => Array.from(new Set([...current, stop.id])))
    try {
      const result = await api.geocode(buildGeocodeQuery(stop.address, stop.city))
      if (geocodeGeneration.current.get(stop.id) === requestNumber) {
        setStops((current) => current.map((item) => item.id === stop.id && item.address === stop.address ? { ...item, geocode: result, city: item.city.trim() || result.city || '', geocodeError: undefined } : item))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Адрес не найден.'
      if (geocodeGeneration.current.get(stop.id) === requestNumber) setStops((current) => current.map((item) => item.id === stop.id ? { ...item, geocode: undefined, geocodeError: message } : item))
    } finally {
      setGeocodingStopIds((current) => current.filter((id) => id !== stop.id))
    }
  }

  function hydrateDraft(selection: ImportSelection, draft: ImportedOrderDraft) {
    const importedStops = buildStopsFromImport(draft)
    const matchedId = findVehicleId(draft)
    setImportSelection(selection); setAppliedImportSelection(selection); setVehicleId(matchedId); setOrderNumber(draft.orderNumber ?? '')
    setCreateNewVehicle(!matchedId && Boolean(draft.vehicleNumber || draft.vehiclePlate))
    setNewVehicleNumber((draft.vehicleNumber || draft.vehiclePlate || '').replace(/^LKW\s*/i, '').trim())
    setNewVehiclePlate(draft.vehiclePlate ?? '')
    setTrailerPlate(draft.trailerPlate ?? '')
    setTourRemarks(draft.tourRemarks ?? '')
    setStops(importedStops); setManualMode(false); setEditing(false); setActiveStopId(null); setError(null); setSuccessMessage(null)
    importedStops.forEach((stop) => { if (stop.address.trim()) void geocodeStop(stop) })
  }

  function selectImportedDraft(selection: ImportSelection) {
    const draft = importItems.find((item) => item.id === selection.itemId)?.preview?.drafts[selection.draftIndex]
    if (draft) hydrateDraft(selection, draft)
  }

  async function handleOrderImport(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []); event.target.value = ''; await importOrderFiles(files)
  }

  async function handleImportDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); event.stopPropagation(); setIsImportDragging(false)
    if (!importing) await importOrderFiles(Array.from(event.dataTransfer.files))
  }

  async function importOrderFiles(files: File[]) {
    if (!files.length) return
    setError(null); setSuccessMessage(null)
    const existingKeys = new Set(importItems.map((item) => item.key))
    const newFiles = files.map((file) => ({ file, key: `${file.name}:${file.size}:${file.lastModified}` })).filter(({ key }) => !existingKeys.has(key)).slice(0, Math.max(0, 10 - importItems.length))
    if (!newFiles.length) { setError(new Error('Добавьте PDF, Excel или скриншот. Один файл повторно не добавляется.')); return }
    const queuedItems: ImportQueueItem[] = newFiles.map(({ file, key }) => ({ id: crypto.randomUUID(), key, fileName: file.name, fileType: classifyImportFile(file), status: 'queued', completedDraftIndexes: [] }))
    setImportItems((current) => [...current, ...queuedItems]); setImporting(true)
    let selectionClaimed = Boolean(importSelection)
    try {
      for (const [index, { file }] of newFiles.entries()) {
        const item = queuedItems[index]
        setImportItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'processing' } : candidate))
        try {
          validateImportFile(file)
          const kind = classifyImportFile(file)
          const preview = kind === 'PDF' ? await api.importPdf(file) : kind === 'EXCEL' ? await api.importExcel(file) : kind === 'IMAGE' ? await api.importImage(file) : null
          if (!preview?.drafts.length) throw new Error('В файле не найдены адреса загрузки или выгрузки.')
          setImportItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'ready', preview } : candidate))
          if (!selectionClaimed) { selectionClaimed = true; hydrateDraft({ itemId: item.id, draftIndex: 0 }, preview.drafts[0]) }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Не удалось распознать файл.'
          setImportItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'error', error: message } : candidate))
        }
      }
    } finally { setImporting(false) }
  }

  function updateStop(stopId: string, patch: Partial<StopDraft>) {
    if (patch.address !== undefined || patch.city !== undefined) geocodeGeneration.current.set(stopId, (geocodeGeneration.current.get(stopId) ?? 0) + 1)
    setStops((current) => current.map((stop) => stop.id === stopId ? { ...stop, ...patch, geocode: patch.address !== undefined || patch.city !== undefined ? undefined : stop.geocode, geocodeError: undefined } : stop))
  }

  function beginManualMode() {
    setManualMode(true); setEditing(true); setAppliedImportSelection(null); setVehicleId(''); setOrderNumber(''); setTrailerPlate(''); setTourRemarks(''); setCreateNewVehicle(false); setStops(createInitialStops()); setError(null); setSuccessMessage(null)
  }

  function returnToImport() {
    if (selectedImportDraft && importSelection) {
      hydrateDraft(importSelection, selectedImportDraft)
      return
    }
    setManualMode(false); setEditing(false); setActiveStopId(null); setAppliedImportSelection(null)
    setVehicleId(''); setOrderNumber(''); setStops(createInitialStops()); setError(null); setSuccessMessage(null)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault(); setError(null); setSuccessMessage(null)
    if (!readyToConfirm) { setEditing(true); setError(new Error('Выберите LKW, укажите номер Auftrag и заполните адрес каждой точки.')); return }
    setSubmitting(true)
    const resolvedStops: StopDraft[] = []
    let firstFailedStopId: string | null = null
    for (const stop of stops) {
      try {
        const geocode = await api.geocode(buildGeocodeQuery(stop.address, stop.city))
        resolvedStops.push({ ...stop, geocode, city: stop.city.trim() || geocode.city || '', geocodeError: undefined })
      } catch (err) {
        resolvedStops.push({ ...stop, geocode: undefined, geocodeError: err instanceof Error ? err.message : 'Адрес не найден.' })
        firstFailedStopId ??= stop.id
      }
    }
    setStops(resolvedStops)
    if (firstFailedStopId) {
      setSubmitting(false); setEditing(true); setActiveStopId(firstFailedStopId)
      setError(new Error('Один из адресов не найден. Исправьте выделенную точку — координаты проверятся автоматически.'))
      requestAnimationFrame(() => document.getElementById(`order-stop-${firstFailedStopId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
      return
    }
    const tourInput = {
      orderNumber: orderNumber.trim(), trailerPlate: trailerPlate.trim() || null, tourRemarks: tourRemarks.trim() || null,
      stops: resolvedStops.map((stop, index): CreateTourStopInput => ({ sequence: index + 1, type: stop.type, company: stop.company.trim() || undefined, address: stop.address.trim(), city: stop.city.trim() || undefined, latitude: stop.geocode!.latitude, longitude: stop.geocode!.longitude, appointmentAt: stop.appointmentAt ? new Date(stop.appointmentAt).toISOString() : null, appointmentWindowStartAt: stop.appointmentWindowStartAt ? new Date(stop.appointmentWindowStartAt).toISOString() : null, appointmentWindowEndAt: stop.appointmentWindowEndAt ? new Date(stop.appointmentWindowEndAt).toISOString() : null, loadingMeters: stop.loadingMeters ? Number(stop.loadingMeters.replace(',', '.')) : null, referenceNumbers: stop.referenceNumbers.split(/[,;\n]+/).map((value) => value.trim()).filter(Boolean), instructions: stop.instructions.trim() || null, serviceMinMinutes: stop.serviceMinMinutes, serviceMaxMinutes: stop.serviceMaxMinutes }))
    }
    try {
      const tour = createNewVehicle
        ? (await api.createTourWithVehicle({ vehicle: { vehicleNumber: newVehicleNumber.trim(), licensePlate: newVehiclePlate.trim() || undefined }, tour: tourInput })).tour
        : await api.createTour({ ...tourInput, vehicleId })
      if (appliedImportSelection) {
        const nextItems = importItems.map((item) => item.id === appliedImportSelection.itemId ? { ...item, completedDraftIndexes: Array.from(new Set([...item.completedDraftIndexes, appliedImportSelection.draftIndex])) } : item)
        const nextSelection = findNextImportSelection(nextItems, appliedImportSelection)
        setImportItems(nextItems)
        if (nextSelection) {
          const nextDraft = nextItems.find((item) => item.id === nextSelection.itemId)?.preview?.drafts[nextSelection.draftIndex]
          if (nextDraft) hydrateDraft(nextSelection, nextDraft)
          setSuccessMessage(`Auftrag ${tour.orderNumber} создан. Осталось подтвердить: ${Math.max(0, remainingImportDrafts - 1)}.`)
          return
        }
      }
      setSuccessMessage(`Auftrag ${tour.orderNumber} создан. Статус: ${statusLabel(tour.status)}`); navigate(`/vehicles/${tour.vehicleId}`)
    } catch (err) { setError(err as Error) } finally { setSubmitting(false) }
  }

  if (vehicles.loading && !vehicles.data) return <LoadingState label="Грузовики загружаются" />
  if (vehicles.error && !vehicles.data) return <ErrorState error={vehicles.error} onRetry={vehicles.refetch} />

  return (
    <form className="mx-auto max-w-[1480px] space-y-5 pb-8" onSubmit={handleSubmit}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="mb-1 text-xs font-bold uppercase tracking-[0.18em] text-sky-700">Auftrag intake</p><h2 className="page-title">Новый заказ</h2><p className="page-subtitle">Загрузите документ, проверьте маршрут и назначьте машину.</p></div>
        <button type="button" className="secondary-button" onClick={manualMode ? returnToImport : beginManualMode}>{manualMode ? 'Вернуться к импорту' : 'Создать вручную'}</button>
      </div>

      {!manualMode ? <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className={`m-4 rounded-xl border-2 border-dashed px-5 py-7 transition-colors ${isImportDragging ? 'border-sky-500 bg-sky-50' : 'border-slate-300 bg-slate-50/70'}`} onDragEnter={(event) => { event.preventDefault(); setIsImportDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsImportDragging(false) }} onDrop={(event) => void handleImportDrop(event)}>
          <div className="flex flex-wrap items-center justify-between gap-5"><div className="flex min-w-0 items-start gap-4"><div className="rounded-xl bg-sky-100 p-3 text-sky-700"><Upload className="h-6 w-6" /></div><div><h3 className="text-lg font-bold text-slate-950">Перетащите Auftrag сюда</h3><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">PDF, Excel или скриншот. Адреса, города и термины распознаются автоматически; файлы можно добавлять очередью.</p><p className="mt-1 text-xs text-slate-500">PDF до 20 МБ · Excel до 5 МБ · PNG, JPG или WebP до 10 МБ</p></div></div>
            <label className={`primary-button cursor-pointer ${importing ? 'pointer-events-none opacity-60' : ''}`}>{importing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}{importing ? 'Распознаём…' : 'Выбрать файлы'}<input className="sr-only" type="file" multiple accept=".pdf,.xlsx,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/png,image/jpeg,image/webp" onChange={(event) => void handleOrderImport(event)} disabled={importing} /></label>
          </div>
        </div>
        {importItems.length ? <div className="border-t border-slate-200 bg-slate-50/60 px-4 py-3"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Sparkles className="h-4 w-4 text-sky-600" />Очередь · {remainingImportDrafts} к подтверждению</div><div className="flex gap-2 overflow-x-auto pb-1">
          {importItems.flatMap((item) => item.status === 'ready' && item.preview ? item.preview.drafts.map((draft, index) => { const selected = importSelection?.itemId === item.id && importSelection.draftIndex === index; const completed = isDraftCompleted(item, index); return <button key={`${item.id}-${index}`} type="button" disabled={completed} onClick={() => selectImportedDraft({ itemId: item.id, draftIndex: index })} className={`min-w-[190px] rounded-lg border px-3 py-2 text-left transition ${selected ? 'border-sky-500 bg-white ring-2 ring-sky-100' : 'border-slate-200 bg-white hover:border-slate-300'} disabled:opacity-50`}><span className="block truncate text-sm font-bold">{completed ? 'Сохранён' : draft.orderNumber || `Запись ${index + 1}`}</span><span className="block truncate text-xs text-slate-500">{item.fileName} · {draft.stops.length} точек</span></button> }) : [<div key={item.id} className="min-w-[220px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><span className="block truncate font-semibold">{item.fileName}</span><span className={item.status === 'error' ? 'text-red-700' : 'text-slate-500'}>{item.status === 'error' ? item.error : 'Распознаётся…'}</span></div>])}
        </div></div> : null}
      </section> : null}

      {vehicles.data && hasOrderDraft ? <section className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h3 className="text-lg font-bold">Маршрут Auftrag</h3><p className="text-sm text-slate-500">Загрузка идёт первой, выгрузка — следующей. Норма точки: 60 минут.</p></div>{selectedImportItem ? <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{selectedImportItem.fileName}</span> : null}</div>
          <div className="space-y-3 p-4 sm:p-5">{stops.map((stop, index) => {
            const isActive = editing && activeStopId === stop.id; const geocoding = geocodingStopIds.includes(stop.id)
            return <article id={`order-stop-${stop.id}`} key={stop.id} className={`overflow-hidden rounded-xl border transition ${stop.geocodeError ? 'border-red-400 bg-red-50/40' : isActive ? 'border-sky-500 ring-2 ring-sky-100' : 'border-slate-200'}`}>
              <button type="button" className="flex w-full min-w-0 items-start gap-4 p-4 text-left" onClick={() => { setEditing(true); setActiveStopId(stop.id) }}><span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-black ${stop.type === 'LOAD' ? 'bg-sky-100 text-sky-800' : 'bg-emerald-100 text-emerald-800'}`}>{index + 1}</span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="font-bold">{stop.type === 'LOAD' ? 'Загрузка' : 'Выгрузка'}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600"><Clock3 className="mr-1 inline h-3 w-3" />60 мин · контроль 120</span>{geocoding ? <span className="text-xs text-sky-700">Проверяем…</span> : stop.geocode ? <span className="text-xs font-semibold text-emerald-700">Адрес найден</span> : null}</span><span className="mt-2 block truncate font-semibold text-slate-800">{stop.address || 'Укажите адрес'}</span><span className="mt-1 block truncate text-sm text-slate-500">{[stop.city, stop.company].filter(Boolean).join(' · ') || 'Город и компания не указаны'}</span>{stop.sourceExcerpt ? <span className="mt-2 block break-words text-xs text-slate-500">Источник{stop.sourcePage ? `, стр. ${stop.sourcePage}` : ''}: {stop.sourceExcerpt}</span> : null}</span><span className="hidden shrink-0 text-right sm:block"><span className="block text-xs font-semibold uppercase text-slate-400">Термин</span><span className="mt-1 block text-sm font-semibold">{stop.appointmentWindowStartAt && stop.appointmentWindowEndAt ? `${appointmentLabel(stop.appointmentWindowStartAt)} — ${appointmentLabel(stop.appointmentWindowEndAt)}` : appointmentLabel(stop.appointmentAt)}</span></span><ChevronRight className="mt-3 h-5 w-5 shrink-0 text-slate-400" /></button>
              {isActive ? <div className="grid gap-3 border-t border-slate-200 bg-slate-50/80 p-4 md:grid-cols-2"><label><span className="field-label">Тип точки</span><select className="field-input" value={stop.type} onChange={(event) => updateStop(stop.id, { type: event.target.value as StopType })}><option value="LOAD">Загрузка</option><option value="UNLOAD">Выгрузка</option></select></label><label><span className="field-label">Компания</span><input className="field-input" value={stop.company} onChange={(event) => updateStop(stop.id, { company: event.target.value })} /></label><label className="md:col-span-2"><span className="field-label">Адрес</span><input autoFocus className="field-input" value={stop.address} onChange={(event) => updateStop(stop.id, { address: event.target.value })} onBlur={() => void geocodeStop(stop)} required /></label><label><span className="field-label">Город</span><input className="field-input" value={stop.city} onChange={(event) => updateStop(stop.id, { city: event.target.value })} onBlur={() => void geocodeStop(stop)} /></label><label><span className="field-label">Точный термин</span><input className="field-input" type="datetime-local" value={stop.appointmentAt} onChange={(event) => updateStop(stop.id, { appointmentAt: event.target.value, appointmentWindowStartAt: '', appointmentWindowEndAt: '' })} /></label><label><span className="field-label">Начало окна</span><input className="field-input" type="datetime-local" value={stop.appointmentWindowStartAt} onChange={(event) => updateStop(stop.id, { appointmentWindowStartAt: event.target.value, appointmentAt: '' })} /></label><label><span className="field-label">Конец окна</span><input className="field-input" type="datetime-local" value={stop.appointmentWindowEndAt} onChange={(event) => updateStop(stop.id, { appointmentWindowEndAt: event.target.value, appointmentAt: '' })} /></label><label><span className="field-label">Погрузочные метры (LM)</span><input className="field-input" inputMode="decimal" value={stop.loadingMeters} onChange={(event) => updateStop(stop.id, { loadingMeters: event.target.value })} placeholder="Например, 10,4" /></label><label><span className="field-label">Референсы</span><input className="field-input" value={stop.referenceNumbers} onChange={(event) => updateStop(stop.id, { referenceNumbers: event.target.value })} placeholder="Через запятую" /></label><label className="md:col-span-2"><span className="field-label">Примечания и инструкции</span><textarea className="field-input min-h-24 resize-y" value={stop.instructions} onChange={(event) => updateStop(stop.id, { instructions: event.target.value })} /></label>{stop.geocodeError ? <div className="md:col-span-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"><AlertTriangle className="mr-2 inline h-4 w-4" />{stop.geocodeError}</div> : null}<div className="flex justify-between gap-2 md:col-span-2"><button type="button" className="danger-button" disabled={stops.length <= 2} onClick={() => setStops((current) => current.filter((item) => item.id !== stop.id))}><Trash2 className="h-4 w-4" />Удалить</button><button type="button" className="secondary-button" onClick={() => setActiveStopId(null)}><Check className="h-4 w-4" />Готово</button></div></div> : null}
            </article>
          })}</div>
          {editing ? <div className="flex gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3"><button type="button" className="secondary-button" onClick={() => { const stop = createStop('LOAD'); setStops((current) => [...current, stop]); setActiveStopId(stop.id) }}><Plus className="h-4 w-4" />Загрузка</button><button type="button" className="secondary-button" onClick={() => { const stop = createStop('UNLOAD'); setStops((current) => [...current, stop]); setActiveStopId(stop.id) }}><Plus className="h-4 w-4" />Выгрузка</button></div> : null}
        </div>
        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start"><section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><label><span className="field-label">Назначить LKW</span><select className="field-input" value={createNewVehicle ? '' : vehicleId} onChange={(event) => { setVehicleId(event.target.value); setCreateNewVehicle(false) }} required={!createNewVehicle} disabled={createNewVehicle}><option value="">Выберите машину</option>{vehicles.data.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicleNumber} {vehicle.licensePlate ? `· ${vehicle.licensePlate}` : ''}</option>)}</select></label><label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={createNewVehicle} onChange={(event) => setCreateNewVehicle(event.target.checked)} />Добавить новую машину из Auftrag</label>{createNewVehicle ? <div className="mt-3 grid gap-2"><input className="field-input" aria-label="Номер новой машины" placeholder="Номер LKW" value={newVehicleNumber} onChange={(event) => setNewVehicleNumber(event.target.value)} required /><input className="field-input" aria-label="Госномер новой машины" placeholder="Госномер (необязательно)" value={newVehiclePlate} onChange={(event) => setNewVehiclePlate(event.target.value)} /></div> : null}<label className="mt-4 block"><span className="field-label">Номер Auftrag</span><input className="field-input" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} required /></label><label className="mt-3 block"><span className="field-label">Прицеп этого тура</span><input className="field-input" value={trailerPlate} onChange={(event) => setTrailerPlate(event.target.value)} placeholder="Например, Z-S3153" /></label>{sequenceHint && !createNewVehicle ? <p className="mt-3 text-xs leading-5 text-slate-500">{sequenceHint}</p> : null}{selectedImportDraft?.vehicleNumber && !findVehicleId(selectedImportDraft) ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs font-medium text-amber-900">LKW «{selectedImportDraft.vehicleNumber}» не найден однозначно. Проверьте машину или создайте новую.</p> : null}</section>{tourRemarks ? <section className="rounded-xl border border-slate-200 bg-white p-4"><label><span className="field-label">Tourbemerkung</span><textarea className="field-input min-h-24" value={tourRemarks} onChange={(event) => setTourRemarks(event.target.value)} /></label></section> : null}
          {importWarnings.length ? <section className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">{importWarnings.map((warning, index) => <p key={`${warning.code}-${index}`} className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{warning.message}</p>)}</section> : null}{error ? <ErrorState error={error} /> : null}{successMessage ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">{successMessage}</div> : null}
          <div className="grid grid-cols-2 gap-3"><button type="button" className="secondary-button min-h-12 justify-center" onClick={() => { setEditing(true); setActiveStopId(stops[0]?.id ?? null) }}><Pencil className="h-4 w-4" />Редактировать</button><button type="submit" className="primary-button min-h-12 justify-center" disabled={!readyToConfirm || submitting}>{submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{submitting ? 'Создаём…' : 'Подтвердить'}</button></div>
        </aside>
      </section> : <EmptyState label="Добавьте PDF, Excel или скриншот Auftrag — либо выберите ручное создание." />}
    </form>
  )
}
