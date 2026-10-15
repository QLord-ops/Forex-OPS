import { AlertTriangle, CheckCircle2, FileUp, LoaderCircle, MapPin, Pencil, Plus, Route, Search, Trash2, X } from 'lucide-react'
import type { ChangeEvent, DragEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'

import { api } from '../lib/api'
import { formatAppointment } from '../lib/format'
import type { Coordinate, CreateTourStopInput, DashboardVehicle, ImportedOrderDraft, ImportedStopDraft, Vehicle } from '../types/domain'

type DockTab = 'search' | 'route' | 'order'
type DraftStop = ImportedStopDraft & { city: string; company: string; address: string; appointmentLocal: string; loadingMetersText: string; referenceText: string; instructionsText: string }
type ManualStop = { type: 'LOAD' | 'UNLOAD'; address: string; appointmentLocal: string }
type RoutePreview = { distanceMeters: number; durationSeconds: number; estimatedArrivalAt: string | null; preliminary: boolean; geometry: Coordinate[] }

export function QuickOrderPanel({
  row,
  vehicles,
  onCreated,
  onAddressFound,
  onRoutePreview
}: {
  row?: DashboardVehicle | null
  vehicles: Vehicle[]
  onCreated: (vehicleId: string) => Promise<void> | void
  onAddressFound?: (coordinate: Coordinate) => void
  onRoutePreview?: (coordinates: Coordinate[]) => void
}) {
  const [tab, setTab] = useState<DockTab | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')
  const [draft, setDraft] = useState<ImportedOrderDraft | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [stops, setStops] = useState<DraftStop[]>([])
  const [vehicleId, setVehicleId] = useState('')
  const [orderNumber, setOrderNumber] = useState('')
  const [editing, setEditing] = useState(false)
  const [createVehicle, setCreateVehicle] = useState(false)
  const [newVehicleNumber, setNewVehicleNumber] = useState('')
  const [newLicensePlate, setNewLicensePlate] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResult, setSearchResult] = useState('')
  const [manualVehicleId, setManualVehicleId] = useState(row?.vehicle.id ?? '')
  const [manualOrderNumber, setManualOrderNumber] = useState('')
  const [manualStops, setManualStops] = useState<ManualStop[]>([
    { type: 'LOAD', address: '', appointmentLocal: '' },
    { type: 'UNLOAD', address: '', appointmentLocal: '' }
  ])
  const [preview, setPreview] = useState<RoutePreview | null>(null)
  const matchState = useMemo(() => vehicleMatch(draft?.vehiclePlate || draft?.vehicleNumber, vehicles), [draft?.vehiclePlate, draft?.vehicleNumber, vehicles])

  useEffect(() => {
    if (row?.vehicle.id && !manualVehicleId) setManualVehicleId(row.vehicle.id)
  }, [row?.vehicle.id, manualVehicleId])

  useEffect(() => {
    function preventFileNavigation(event: DragEvent | globalThis.DragEvent) {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    function onWindowDrop(event: globalThis.DragEvent) {
      if (!event.dataTransfer?.files.length) return
      event.preventDefault()
      setDragging(false)
      setTab('order')
      queueFiles(Array.from(event.dataTransfer.files))
    }
    window.addEventListener('dragover', preventFileNavigation as EventListener)
    window.addEventListener('drop', onWindowDrop)
    return () => {
      window.removeEventListener('dragover', preventFileNavigation as EventListener)
      window.removeEventListener('drop', onWindowDrop)
    }
  })

  function queueFiles(files: File[]) {
    const supported = files.filter((file) => classifyFile(file) !== 'UNKNOWN')
    if (!supported.length) { setError('Поддерживаются PDF, XLSX, PNG, JPG и WEBP.'); return }
    if (draft || busy) setPendingFiles((current) => [...current, ...supported])
    else { void analyze(supported[0]); setPendingFiles((current) => [...current, ...supported.slice(1)]) }
  }

  async function analyze(file: File) {
    setError(''); setBusy(true); setFileName(file.name)
    try {
      const kind = classifyFile(file)
      const result = kind === 'PDF' ? await api.importPdf(file) : kind === 'EXCEL' ? await api.importExcel(file) : kind === 'IMAGE' ? await api.importImage(file) : null
      if (!result?.drafts.length) throw new Error('В файле не найден Auftrag с точками маршрута.')
      const next = result.drafts[0]
      const match = vehicleMatch(next.vehiclePlate || next.vehicleNumber, vehicles)
      setDraft(next); setOrderNumber(next.orderNumber ?? ''); setVehicleId(match.id ?? '')
      setCreateVehicle(false)
      setNewVehicleNumber(next.vehicleNumber && !looksLikePlate(next.vehicleNumber) ? next.vehicleNumber : '')
      setNewLicensePlate(next.vehiclePlate || (next.vehicleNumber && looksLikePlate(next.vehicleNumber) ? next.vehicleNumber : ''))
      setStops(next.stops.slice().sort((a, b) => a.sequence - b.sequence).map(toDraftStop))
      setEditing(false); setTab('order')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось распознать Auftrag.')
    } finally { setBusy(false) }
  }

  function nextFile() {
    setDraft(null); setEditing(false)
    const next = pendingFiles[0]
    setPendingFiles((current) => current.slice(1))
    if (next) queueMicrotask(() => void analyze(next))
  }

  async function resolveStops(input: Array<{ type: 'LOAD' | 'UNLOAD'; address: string; city?: string; company?: string; appointmentLocal: string; appointmentWindowStartLocal?: string | null; appointmentWindowEndLocal?: string | null; loadingMetersText?: string; referenceText?: string; instructionsText?: string }>): Promise<CreateTourStopInput[]> {
    const resolved: CreateTourStopInput[] = []
    for (const [index, stop] of input.entries()) {
      const place = await api.geocode([stop.address.trim(), stop.city?.trim()].filter(Boolean).join(', '))
      resolved.push({
        sequence: index + 1,
        type: stop.type,
        company: stop.company?.trim() || undefined,
        address: stop.address.trim(),
        city: stop.city?.trim() || place.city || undefined,
        latitude: place.latitude,
        longitude: place.longitude,
        appointmentAt: stop.appointmentLocal ? new Date(stop.appointmentLocal).toISOString() : null,
        appointmentWindowStartAt: stop.appointmentWindowStartLocal ? new Date(stop.appointmentWindowStartLocal).toISOString() : null,
        appointmentWindowEndAt: stop.appointmentWindowEndLocal ? new Date(stop.appointmentWindowEndLocal).toISOString() : null,
        loadingMeters: stop.loadingMetersText ? Number(stop.loadingMetersText.replace(',', '.')) : null,
        referenceNumbers: splitReferences(stop.referenceText ?? ''),
        instructions: stop.instructionsText?.trim() || null,
        serviceMinMinutes: 60,
        serviceMaxMinutes: 120
      })
    }
    return resolved
  }

  async function confirm() {
    if ((!vehicleId && !createVehicle) || (createVehicle && !newVehicleNumber.trim()) || !orderNumber.trim() || stops.length < 2 || stops.some((stop) => !stop.address.trim())) {
      setEditing(true); setError('Выберите или создайте LKW, укажите номер Auftrag и заполните адреса минимум двух точек.'); return
    }
    setBusy(true); setError('')
    try {
      const resolved = await resolveStops(stops)
      const metadata = { trailerPlate: draft?.trailerPlate || undefined, tourRemarks: draft?.tourRemarks || undefined }
      const createdVehicleId = createVehicle
        ? (await api.createTourWithVehicle({ vehicle: { vehicleNumber: newVehicleNumber.trim(), licensePlate: newLicensePlate.trim() || undefined }, tour: { orderNumber: orderNumber.trim(), stops: resolved, ...metadata } })).vehicle.id
        : vehicleId
      if (!createVehicle) await api.createTour({ vehicleId, orderNumber: orderNumber.trim(), stops: resolved, ...metadata })
      await onCreated(createdVehicleId)
      nextFile()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось создать Auftrag.') }
    finally { setBusy(false) }
  }

  async function findAddress() {
    if (!searchQuery.trim()) return
    setBusy(true); setError(''); setSearchResult('')
    try {
      const place = await api.geocode(searchQuery.trim())
      setSearchResult(place.address)
      onAddressFound?.([place.longitude, place.latitude])
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Адрес не найден') }
    finally { setBusy(false) }
  }

  async function previewManualTour() {
    if (manualStops.length < 2 || manualStops.some((stop) => !stop.address.trim())) { setError('Заполните адреса минимум двух точек.'); return }
    setBusy(true); setError(''); setPreview(null)
    try {
      const resolved = await resolveStops(manualStops)
      const result = await api.previewNewTour({ vehicleId: manualVehicleId || undefined, stops: resolved })
      setPreview(result); onRoutePreview?.(result.geometry)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось рассчитать маршрут.') }
    finally { setBusy(false) }
  }

  async function createManualTour() {
    if (!manualVehicleId || !manualOrderNumber.trim() || manualStops.length < 2 || manualStops.some((stop) => !stop.address.trim())) {
      setError('Укажите машину, номер Auftrag и минимум две точки с адресами.'); return
    }
    setBusy(true); setError('')
    try {
      const resolved = await resolveStops(manualStops)
      await api.createTour({ vehicleId: manualVehicleId, orderNumber: manualOrderNumber.trim(), stops: resolved })
      setManualOrderNumber('')
      setManualStops([{ type: 'LOAD', address: '', appointmentLocal: '' }, { type: 'UNLOAD', address: '', appointmentLocal: '' }])
      setPreview(null); onRoutePreview?.([]); setTab(null)
      await onCreated(manualVehicleId)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось создать маршрут.') }
    finally { setBusy(false) }
  }

  function updateStop(index: number, patch: Partial<DraftStop>) { setStops((current) => current.map((stop, stopIndex) => stopIndex === index ? { ...stop, ...patch } : stop)) }
  function updateManualStop(index: number, patch: Partial<ManualStop>) { setManualStops((current) => current.map((stop, stopIndex) => stopIndex === index ? { ...stop, ...patch } : stop)); setPreview(null); onRoutePreview?.([]) }
  function toggleTab(next: DockTab) { setTab((current) => current === next ? null : next); setError('') }
  function onFileInput(event: ChangeEvent<HTMLInputElement>) { const files = Array.from(event.target.files ?? []); event.target.value = ''; queueFiles(files) }
  function onDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); event.stopPropagation(); setDragging(false); queueFiles(Array.from(event.dataTransfer.files)) }

  return <>
    <aside className="map-action-dock" aria-label="Действия с картой и Auftrag">
      <div className="map-action-bar">
        <button type="button" className={tab === 'search' ? 'active' : ''} onClick={() => toggleTab('search')} aria-expanded={tab === 'search'}><Search className="h-4 w-4" />Адрес</button>
        <button type="button" className={tab === 'route' ? 'active' : ''} onClick={() => toggleTab('route')} aria-expanded={tab === 'route'}><Route className="h-4 w-4" />Маршрут</button>
        <button type="button" className={tab === 'order' ? 'active' : ''} onClick={() => toggleTab('order')} aria-expanded={tab === 'order'}><FileUp className="h-4 w-4" />Auftrag{pendingFiles.length ? ' · ' + pendingFiles.length : ''}</button>
      </div>
      {tab ? <div className="map-action-body">
        <div className="map-action-heading"><strong>{tab === 'search' ? 'Найти адрес' : tab === 'route' ? 'Новый маршрут' : 'Добавить Auftrag'}</strong><button type="button" className="icon-button icon-button-compact" onClick={() => setTab(null)} aria-label="Свернуть"><X className="h-4 w-4" /></button></div>
        {tab === 'search' ? <div className="map-action-content"><label className="field-label" htmlFor="map-search-address">Полный адрес или город</label><div className="flex gap-2"><input id="map-search-address" className="field-input min-w-0" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void findAddress() }} placeholder="Улица, дом, город" /><button type="button" className="primary-button" onClick={() => void findAddress()} disabled={busy}><Search className="h-4 w-4" /></button></div>{searchResult ? <p className="map-action-result"><MapPin className="h-4 w-4" />{searchResult}</p> : null}</div> : null}
        {tab === 'route' ? <div className="map-action-content"><label className="field-label">Машина<select className="field-input mt-1" value={manualVehicleId} onChange={(event) => { setManualVehicleId(event.target.value); setPreview(null); onRoutePreview?.([]) }}><option value="">Выберите LKW</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>LKW {vehicle.vehicleNumber}{vehicle.licensePlate ? ' · ' + vehicle.licensePlate : ''}</option>)}</select></label><label className="field-label mt-3 block">Номер Auftrag<input className="field-input mt-1" value={manualOrderNumber} onChange={(event) => setManualOrderNumber(event.target.value)} placeholder="Номер заказа" /></label><div className="manual-route-stops">{manualStops.map((stop, index) => <article key={index}><div className="flex items-center gap-2"><span className="manual-route-index">{index + 1}</span><select className="field-input" value={stop.type} onChange={(event) => updateManualStop(index, { type: event.target.value as ManualStop['type'] })}><option value="LOAD">Загрузка</option><option value="UNLOAD">Выгрузка</option></select><button type="button" className="icon-button icon-button-compact" disabled={manualStops.length <= 2} onClick={() => { setManualStops((current) => current.filter((_, stopIndex) => stopIndex !== index)); setPreview(null); onRoutePreview?.([]) }} aria-label="Удалить точку"><Trash2 className="h-4 w-4" /></button></div><input className="field-input mt-2" value={stop.address} onChange={(event) => updateManualStop(index, { address: event.target.value })} placeholder="Улица, дом, индекс, город" /><input className="field-input mt-2" type="datetime-local" aria-label="Термин (необязательно)" value={stop.appointmentLocal} onChange={(event) => updateManualStop(index, { appointmentLocal: event.target.value })} /></article>)}</div><button type="button" className="secondary-button mt-2 w-full" onClick={() => { setManualStops((current) => [...current, { type: 'UNLOAD', address: '', appointmentLocal: '' }]); setPreview(null); onRoutePreview?.([]) }}><Plus className="h-4 w-4" />Добавить точку</button><div className="map-action-footer"><button type="button" className="secondary-button" disabled={busy} onClick={() => void previewManualTour()}>Показать путь и ETA</button><button type="button" className="primary-button" disabled={busy} onClick={() => void createManualTour()}>Подтвердить тур</button></div>{preview ? <p className="map-action-result"><Route className="h-4 w-4" />{Math.round(preview.distanceMeters / 1000)} км · {Math.round(preview.durationSeconds / 60)} мин{preview.estimatedArrivalAt ? ' · ETA ' + formatAppointment(preview.estimatedArrivalAt) : ''}{preview.preliminary ? ' · предварительно' : ''}</p> : <p className="quick-order-hint">До подтверждения тур не сохраняется. ETA появится после расчёта пути.</p>}</div> : null}
        {tab === 'order' ? <div className="map-action-content"><div className={'quick-order-drop ' + (dragging ? 'dragging' : '')} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}><FileUp className="h-7 w-7" /><strong>{busy ? 'Распознаём Auftrag…' : 'Перетащите Auftrag сюда'}</strong><span>PDF, Excel или скриншот</span><label className="secondary-button cursor-pointer">Выбрать файлы<input className="sr-only" type="file" multiple accept=".pdf,.xlsx,.png,.jpg,.jpeg,.webp" onChange={onFileInput} disabled={busy} /></label></div><p className="quick-order-hint">Каждый файл проверяется отдельно. Исходный файл не сохраняется.</p></div> : null}
        {error && !draft ? <p className="quick-order-error"><AlertTriangle className="h-4 w-4" />{error}</p> : null}
      </div> : null}
    </aside>
    {draft ? <div className="quick-order-modal-backdrop" role="presentation"><section className="quick-order-modal" role="dialog" aria-modal="true" aria-label="Проверка Auftrag"><header><div className="min-w-0"><p>Проверка распознавания</p><h2>{fileName}</h2></div><button type="button" className="icon-button" onClick={nextFile} aria-label="Закрыть"><X className="h-4 w-4" /></button></header><div className="quick-order-modal-body"><div className="quick-order-meta"><label><span className="field-label">LKW из документа: {draft.vehiclePlate || draft.vehicleNumber || 'не указан'}</span><select className="field-input" value={vehicleId} onChange={(event) => { setVehicleId(event.target.value); setCreateVehicle(false) }} disabled={createVehicle}><option value="">Выберите машину</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>LKW {vehicle.vehicleNumber}{vehicle.licensePlate ? ' · ' + vehicle.licensePlate : ''}</option>)}</select></label><label><span className="field-label">Номер Auftrag</span><input className="field-input" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} readOnly={!editing} /></label></div>{matchState.status !== 'MATCHED' ? <p className="quick-order-warning"><AlertTriangle className="h-4 w-4" />{matchState.status === 'AMBIGUOUS' ? 'Номер найден у нескольких машин.' : 'Машина из Auftrag не найдена.'} Выберите LKW или создайте новую.</p> : null}<label className="quick-create-vehicle"><input type="checkbox" checked={createVehicle} onChange={(event) => { setCreateVehicle(event.target.checked); if (event.target.checked) setVehicleId('') }} />Создать новую машину из Auftrag</label>{createVehicle ? <div className="quick-order-meta mt-2"><label><span className="field-label">Внутренний номер LKW</span><input className="field-input" value={newVehicleNumber} onChange={(event) => setNewVehicleNumber(event.target.value)} /></label><label><span className="field-label">Госномер</span><input className="field-input" value={newLicensePlate} onChange={(event) => setNewLicensePlate(event.target.value)} /></label></div> : null}{draft.trailerPlate ? <p className="quick-order-source">Прицеп: <strong>{draft.trailerPlate}</strong></p> : null}{draft.tourRemarks ? <p className="quick-order-source">Tourbemerkung{draft.tourRemarksSourcePage ? ' · стр. ' + draft.tourRemarksSourcePage : ''}: <strong>{draft.tourRemarks}</strong></p> : null}<div className="quick-order-stop-list">{stops.map((stop, index) => <article key={index} className="quick-order-review-stop"><div className="quick-order-review-title"><span>{index + 1}</span><strong>{stop.type === 'LOAD' ? 'Загрузка' : 'Выгрузка'}</strong>{stop.sourcePage ? <small>Стр. {stop.sourcePage}</small> : null}</div>{editing ? <div className="grid gap-3 md:grid-cols-2"><label className="md:col-span-2"><span className="field-label">Полный адрес</span><input className="field-input" value={stop.address} onChange={(event) => updateStop(index, { address: event.target.value })} /></label><label><span className="field-label">Город</span><input className="field-input" value={stop.city} onChange={(event) => updateStop(index, { city: event.target.value })} /></label><label><span className="field-label">Термин</span><input className="field-input" type="datetime-local" value={stop.appointmentLocal} onChange={(event) => updateStop(index, { appointmentLocal: event.target.value })} /></label><label><span className="field-label">LM, погрузочные метры</span><input className="field-input" value={stop.loadingMetersText} onChange={(event) => updateStop(index, { loadingMetersText: event.target.value })} /></label><label><span className="field-label">Референсы</span><input className="field-input" value={stop.referenceText} onChange={(event) => updateStop(index, { referenceText: event.target.value })} /></label><label className="md:col-span-2"><span className="field-label">Примечания</span><textarea className="field-input min-h-20" value={stop.instructionsText} onChange={(event) => updateStop(index, { instructionsText: event.target.value })} /></label></div> : <><p className="font-bold text-slate-900">{stop.address || 'Адрес не распознан'}</p><p className="text-sm text-slate-500">{stop.city || 'Город не указан'} · {formatAppointment(stop.appointmentLocal)}</p>{stop.appointmentWindowStartLocal && stop.appointmentWindowEndLocal ? <p className="text-xs text-slate-600">Окно: {formatAppointment(stop.appointmentWindowStartLocal)} — {formatAppointment(stop.appointmentWindowEndLocal)}</p> : null}{stop.sourceExcerpt ? <p className="quick-order-source">Источник: {stop.sourceExcerpt}</p> : null}{cargoSummary(stop.loadingMeters, stop.referenceNumbers, stop.instructions)}</>}</article>)}</div>{draft.warnings.length ? <div className="quick-order-warning"><AlertTriangle className="h-4 w-4" /><span>{draft.warnings.map((warning) => warning.message).join(' · ')}</span></div> : null}{error ? <p className="quick-order-error"><AlertTriangle className="h-4 w-4" />{error}</p> : null}</div><footer><button type="button" className="secondary-button" onClick={() => setEditing((value) => !value)}><Pencil className="h-4 w-4" />{editing ? 'Завершить правки' : 'Редактировать'}</button><button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{busy ? 'Создаём…' : 'Подтвердить'}</button></footer></section></div> : null}
  </>
}

function toDraftStop(stop: ImportedStopDraft): DraftStop { return { ...stop, city: stop.city ?? '', company: stop.company ?? '', address: stop.address ?? '', appointmentLocal: stop.appointmentLocal ?? '', loadingMetersText: stop.loadingMeters?.toString() ?? '', referenceText: stop.referenceNumbers?.join(', ') ?? '', instructionsText: stop.instructions ?? '' } }
function splitReferences(value: string) { return value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean).slice(0, 20) }
function normalizeVehicle(value: string) { return value.toLocaleUpperCase('de-DE').replace(/[^A-ZА-Я0-9]/g, '') }
function looksLikePlate(value: string) { return /[A-ZА-Я]+[- ]?[A-ZА-Я0-9]+[- ]?[0-9]+/i.test(value) }
function vehicleMatch(requested: string | null | undefined, vehicles: Vehicle[]): { status: 'MATCHED' | 'AMBIGUOUS' | 'NOT_FOUND'; id?: string } {
  if (!requested) return { status: 'NOT_FOUND' }
  const key = normalizeVehicle(requested)
  const matches = vehicles.filter((vehicle) => [vehicle.vehicleNumber, vehicle.licensePlate ?? ''].some((value) => normalizeVehicle(value) === key))
  return matches.length === 1 ? { status: 'MATCHED', id: matches[0].id } : matches.length > 1 ? { status: 'AMBIGUOUS' } : { status: 'NOT_FOUND' }
}
function classifyFile(file: File): 'PDF' | 'EXCEL' | 'IMAGE' | 'UNKNOWN' {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) return 'PDF'
  if (name.endsWith('.xlsx')) return 'EXCEL'
  if (/[.](png|jpe?g|webp)$/.test(name)) return 'IMAGE'
  return 'UNKNOWN'
}
function cargoSummary(meters?: number | null, references?: string[] | null, instructions?: string | null) {
  if (!meters && !references?.length && !instructions) return null
  return <div className="quick-cargo"><span>{meters ? meters + ' LM' : 'LM не указан'}</span>{references?.length ? <span>Ref: {references.join(', ')}</span> : null}{instructions ? <p>{instructions}</p> : null}</div>
}
