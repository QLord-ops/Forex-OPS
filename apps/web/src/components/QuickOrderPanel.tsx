import { AlertTriangle, CheckCircle2, FileUp, LoaderCircle, MapPin, Pencil, Route, Search, X } from 'lucide-react'
import type { ChangeEvent, DragEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../lib/api'
import { previewRouteScenario } from '../lib/assistant-api'
import { formatAppointment } from '../lib/format'
import type { AddressResolution, Coordinate, CreateTourStopInput, DashboardVehicle, ImportedOrderDraft, ImportedStopDraft, Vehicle } from '../types/domain'

type DockTab = 'search' | 'route' | 'order'
type DraftStop = ImportedStopDraft & { city: string; company: string; address: string; appointmentLocal: string; loadingMetersText: string; referenceText: string; instructionsText: string; resolution?: AddressResolution | null }
type RouteSummary = { distanceMeters: number; arrival: string | null; warnings: string[] }

export function QuickOrderPanel({
  row,
  vehicles,
  onCreated,
  onAddressFound,
  onRoutePreview,
  importOnly = false,
  onImportActivity
}: {
  importOnly?: boolean
  onImportActivity?: () => void
  row?: DashboardVehicle | null
  vehicles: Vehicle[]
  onCreated: (vehicleId: string) => Promise<void> | void
  onAddressFound?: (coordinate: Coordinate) => void
  onRoutePreview?: (coordinates: Coordinate[]) => void
}) {
  const cachedImport = useMemo(() => { if (!importOnly) return null; try { return JSON.parse(sessionStorage.getItem('ops-assistant-import-v1') ?? 'null') as { draft: ImportedOrderDraft | null; stops: DraftStop[]; vehicleId: string; orderNumber: string; fileName: string; pendingDrafts: Array<{ draft: ImportedOrderDraft; fileName: string }>; editing: boolean; createVehicle: boolean; newVehicleNumber: string; newLicensePlate: string; importAttemptId?: string } | null } catch { return null } }, [importOnly])
  const [tab, setTab] = useState<DockTab | null>(importOnly ? 'order' : null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState(cachedImport?.fileName ?? '')
  const [draft, setDraft] = useState<ImportedOrderDraft | null>(cachedImport?.draft ?? null)
  const [pendingDrafts, setPendingDrafts] = useState<Array<{ draft: ImportedOrderDraft; fileName: string }>>(cachedImport?.pendingDrafts ?? [])
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [stops, setStops] = useState<DraftStop[]>(cachedImport?.stops ?? [])
  const [vehicleId, setVehicleId] = useState(cachedImport?.vehicleId ?? '')
  const [orderNumber, setOrderNumber] = useState(cachedImport?.orderNumber ?? '')
  const [editing, setEditing] = useState(cachedImport?.editing ?? false)
  const [createVehicle, setCreateVehicle] = useState(cachedImport?.createVehicle ?? false)
  const [newVehicleNumber, setNewVehicleNumber] = useState(cachedImport?.newVehicleNumber ?? '')
  const [newLicensePlate, setNewLicensePlate] = useState(cachedImport?.newLicensePlate ?? '')
  const [importAttemptId, setImportAttemptId] = useState(cachedImport?.importAttemptId ?? createImportAttemptId())
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResult, setSearchResult] = useState('')
  const selectedVehicleId = row?.vehicle.id
  const selectedVehicleNumber = row?.vehicle.vehicleNumber
  const [routeFrom, setRouteFrom] = useState(selectedVehicleNumber ? `LKW ${selectedVehicleNumber}` : '')
  const [routeTo, setRouteTo] = useState('')
  const [preview, setPreview] = useState<RouteSummary | null>(null)
  const [routeBusy, setRouteBusy] = useState(false)
  const routeRequest = useRef(0)
  const addressRequest = useRef(0)
  const matchState = useMemo(() => vehicleMatch(draft?.vehiclePlate || draft?.vehicleNumber, vehicles), [draft?.vehiclePlate, draft?.vehicleNumber, vehicles])

  useEffect(() => {
    if (!importOnly) return
    try { sessionStorage.setItem('ops-assistant-import-v1', JSON.stringify({ draft, stops, vehicleId, orderNumber, fileName, pendingDrafts, editing, createVehicle, newVehicleNumber, newLicensePlate, importAttemptId })) } catch { /* Storage may be unavailable. */ }
  }, [importOnly, draft, stops, vehicleId, orderNumber, fileName, pendingDrafts, editing, createVehicle, newVehicleNumber, newLicensePlate, importAttemptId])

  useEffect(() => {
    routeRequest.current += 1
    setRouteFrom(selectedVehicleNumber ? `LKW ${selectedVehicleNumber}` : '')
    setPreview(null)
    setRouteBusy(false)
  }, [selectedVehicleId, selectedVehicleNumber])

  useEffect(() => () => { routeRequest.current += 1 }, [])

  useEffect(() => {
    if (!draft || !stops.length) return
    const requestId = ++addressRequest.current
    const snapshot = stops
    setBusy(true)
    void (async () => {
      const next: DraftStop[] = []
      const failures: string[] = []
      for (const [index, stop] of snapshot.entries()) {
        if (!stop.address.trim()) { next.push({ ...stop, resolution: null }); continue }
        try {
          next.push({ ...stop, resolution: await api.resolveAddress({ address: stop.address.trim(), city: stop.city.trim() || null }) })
        } catch (cause) {
          next.push({ ...stop, resolution: null })
          failures.push(`Точка ${index + 1}: ${cause instanceof Error ? cause.message : 'адрес не найден'}`)
        }
      }
      if (requestId !== addressRequest.current) return
      setStops(next)
      if (failures.length) setError(failures.join(' · '))
    })().finally(() => { if (requestId === addressRequest.current) setBusy(false) })
    return () => { addressRequest.current += 1 }
    // A new parsed draft starts one address-resolution pass; edits are resolved on confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

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
    if (!importOnly) return
    window.addEventListener('dragover', preventFileNavigation as EventListener)
    window.addEventListener('drop', onWindowDrop)
    return () => {
      window.removeEventListener('dragover', preventFileNavigation as EventListener)
      window.removeEventListener('drop', onWindowDrop)
    }
  })

  function queueFiles(files: File[]) {
    onImportActivity?.()
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
      setPendingDrafts((current) => [...current, ...result.drafts.slice(1).map((item) => ({ draft: item, fileName: file.name }))])
      const next = result.drafts[0]
      const match = vehicleMatch(next.vehiclePlate || next.vehicleNumber, vehicles)
      setImportAttemptId(createImportAttemptId())
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
    setDraft(null); setEditing(false); setImportAttemptId(createImportAttemptId())
    const queued = pendingDrafts[0]
    if (queued) {
      setPendingDrafts((current) => current.slice(1)); setDraft(queued.draft); setFileName(queued.fileName); setOrderNumber(queued.draft.orderNumber ?? ''); setVehicleId(vehicleMatch(queued.draft.vehiclePlate || queued.draft.vehicleNumber, vehicles).id ?? ''); setStops(queued.draft.stops.slice().sort((a, b) => a.sequence - b.sequence).map(toDraftStop)); setCreateVehicle(false); setNewVehicleNumber(queued.draft.vehicleNumber ?? ''); setNewLicensePlate(queued.draft.vehiclePlate ?? ''); return
    }
    const next = pendingFiles[0]
    setPendingFiles((current) => current.slice(1))
    if (next) queueMicrotask(() => void analyze(next))
  }

  async function resolveStops(input: Array<{ type: 'LOAD' | 'UNLOAD'; address: string; city?: string; company?: string; appointmentLocal: string; appointmentWindowStartLocal?: string | null; appointmentWindowEndLocal?: string | null; loadingMetersText?: string; referenceText?: string; instructionsText?: string }>): Promise<CreateTourStopInput[]> {
    const resolved: CreateTourStopInput[] = []
    for (const [index, stop] of input.entries()) {
      const cached = 'resolution' in stop ? (stop as DraftStop).resolution : undefined
      const place = cached?.sourceAddress === stop.address.trim()
        ? cached
        : await api.resolveAddress({ address: stop.address.trim(), city: stop.city?.trim() || null })
      resolved.push({
        sequence: index + 1,
        type: stop.type,
        company: stop.company?.trim() || undefined,
        address: stop.address.trim(),
        sourceAddress: stop.address.trim(),
        resolvedAddress: place.resolvedAddress,
        geocodePrecision: place.precision,
        geocodeProvider: place.provider || null,
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
      if (!createVehicle) {
        const importFingerprint = await createImportFingerprint({ fileName, orderNumber: orderNumber.trim(), stops, trailerPlate: draft?.trailerPlate })
        await api.confirmImportedTour({ vehicleId, orderNumber: orderNumber.trim(), stops: resolved, ...metadata, importAttemptId, importFingerprint })
      }
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

  function invalidateRoute() {
    routeRequest.current += 1
    setPreview(null)
    setRouteBusy(false)
    setError('')
    onRoutePreview?.([])
  }

  async function previewManualTour() {
    const from = routeFrom.trim()
    const to = routeTo.trim()
    if (!from || !to) { setError('Укажите откуда и куда построить маршрут.'); return }
    const requestedVehicle = from.replace(/^LKW\s*/i, '')
    const match = vehicleMatch(requestedVehicle, vehicles)
    if (match.status === 'AMBIGUOUS') { setError('Номер найден у нескольких машин. Укажите уникальный госномер.'); return }
    if (match.status !== 'MATCHED' && (/^LKW\b/i.test(from) || /^\d+$/.test(from))) {
      setError('Машина не найдена. Укажите её номер, госномер или город отправления.'); return
    }
    const requestId = ++routeRequest.current
    setRouteBusy(true); setError(''); setPreview(null); onRoutePreview?.([])
    try {
      if (match.id) {
        const result = await previewRouteScenario({ vehicleId: match.id, startMode: 'NOW', stops: [{ address: to, type: 'VISIT', serviceMinMinutes: 0, serviceMaxMinutes: 0 }] })
        if (requestId !== routeRequest.current) return
        setPreview({ distanceMeters: result.distanceMeters, arrival: result.completion.latest, warnings: result.warnings })
        onRoutePreview?.(result.geometry)
      } else {
        const result = await api.previewNewTour({ stops: [{ address: from }, { address: to }] })
        if (requestId !== routeRequest.current) return
        setPreview({ distanceMeters: result.distanceMeters, arrival: result.estimatedArrivalAt, warnings: result.preliminary ? ['Предварительный расчёт. Актуальные пробки и ограничения могут быть недоступны.'] : [] })
        onRoutePreview?.(result.geometry)
      }
    } catch (cause) {
      if (requestId === routeRequest.current) setError(cause instanceof Error ? cause.message : 'Не удалось рассчитать маршрут.')
    } finally {
      if (requestId === routeRequest.current) setRouteBusy(false)
    }
  }

  function updateStop(index: number, patch: Partial<DraftStop>) { setStops((current) => current.map((stop, stopIndex) => stopIndex === index ? { ...stop, ...patch, ...(('address' in patch || 'city' in patch) ? { resolution: undefined } : {}) } : stop)) }
  function toggleTab(next: DockTab) { setTab((current) => current === next ? null : next); setError('') }
  function onFileInput(event: ChangeEvent<HTMLInputElement>) { const files = Array.from(event.target.files ?? []); event.target.value = ''; queueFiles(files) }
  function onDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); event.stopPropagation(); setDragging(false); queueFiles(Array.from(event.dataTransfer.files)) }

  return <>
    <aside className={importOnly ? "dispatcher-import" : "map-action-dock"} aria-label="Действия с картой и Auftrag">
      {!importOnly ? <div className="map-action-bar">
        <button type="button" className={tab === 'search' ? 'active' : ''} onClick={() => toggleTab('search')} aria-expanded={tab === 'search'}><Search className="h-4 w-4" />Адрес</button>
        <button type="button" className={tab === 'route' ? 'active' : ''} onClick={() => toggleTab('route')} aria-expanded={tab === 'route'}><Route className="h-4 w-4" />Маршрут</button>

      </div> : null}
      {tab ? <div className="map-action-body">
        <div className="map-action-heading"><strong>{tab === 'search' ? 'Найти адрес' : tab === 'route' ? 'Новый маршрут' : 'Добавить Auftrag'}</strong><button type="button" className="icon-button icon-button-compact" onClick={() => setTab(null)} aria-label="Свернуть"><X className="h-4 w-4" /></button></div>
        {tab === 'search' ? <div className="map-action-content"><label className="field-label" htmlFor="map-search-address">Полный адрес или город</label><div className="flex gap-2"><input id="map-search-address" className="field-input min-w-0" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void findAddress() }} placeholder="Улица, дом, город" /><button type="button" className="primary-button" onClick={() => void findAddress()} disabled={busy}><Search className="h-4 w-4" /></button></div>{searchResult ? <p className="map-action-result"><MapPin className="h-4 w-4" />{searchResult}</p> : null}</div> : null}
        {tab === 'route' ? <form className="map-action-content" onSubmit={(event) => { event.preventDefault(); void previewManualTour() }}>
          <label className="field-label" htmlFor="route-from">Откуда</label>
          <input id="route-from" className="field-input mt-1" value={routeFrom} list="route-vehicles" onChange={(event) => { invalidateRoute(); setRouteFrom(event.target.value) }} placeholder="Номер машины, город или адрес" autoComplete="off" />
          <datalist id="route-vehicles">{vehicles.map((vehicle) => <option key={vehicle.id} value={`LKW ${vehicle.vehicleNumber}`}>{vehicle.licensePlate || vehicle.vehicleNumber}</option>)}</datalist>
          <label className="field-label mt-3 block" htmlFor="route-to">Куда</label>
          <input id="route-to" className="field-input mt-1" value={routeTo} onChange={(event) => { invalidateRoute(); setRouteTo(event.target.value) }} placeholder="Город или полный адрес" autoComplete="off" />
          <p className="quick-order-hint">Номер машины — от её текущей позиции. Два адреса — свободный маршрут без изменения тура.</p>
          <button type="submit" className="primary-button mt-3 w-full" disabled={routeBusy || !routeFrom.trim() || !routeTo.trim()}>{routeBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />}{routeBusy ? 'Строим маршрут…' : 'Проложить маршрут'}</button>
          {preview ? <div className="manual-scenario-result" aria-live="polite"><strong>{Math.round(preview.distanceMeters / 1000)} км</strong>{preview.arrival ? <p>Прибытие: {formatAppointment(preview.arrival)}</p> : <p>Время прибытия пока неизвестно.</p>}{preview.warnings.map((warning, index) => <p key={index} className="quick-order-warning">{warning}</p>)}</div> : null}
        </form> : null}
        {tab === 'order' ? <div className="map-action-content"><div className={'quick-order-drop ' + (dragging ? 'dragging' : '')} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}><FileUp className="h-7 w-7" /><strong>{busy ? 'Распознаём Auftrag…' : 'Перетащите Auftrag сюда'}</strong><span>PDF, Excel или скриншот</span><label className="secondary-button cursor-pointer">Выбрать файлы<input className="sr-only" type="file" multiple accept=".pdf,.xlsx,.png,.jpg,.jpeg,.webp" onChange={onFileInput} disabled={busy} /></label></div><p className="quick-order-hint">Каждый заказ проверяется отдельно. В очереди: {pendingDrafts.length + pendingFiles.length}. Исходный файл не сохраняется.</p></div> : null}
        {error && !draft ? <p className="quick-order-error"><AlertTriangle className="h-4 w-4" />{error}</p> : null}
      </div> : null}
    </aside>
    {draft ? <div className="dispatcher-review"><section aria-label="Проверка Auftrag"><header><div className="min-w-0"><p>Проверка распознавания</p><h2>{fileName}</h2></div><button type="button" className="icon-button" onClick={nextFile} aria-label="Пропустить текущий заказ"><X className="h-4 w-4" /></button></header><div className="quick-order-modal-body"><div className="quick-order-meta"><label><span className="field-label">LKW из документа: {draft.vehiclePlate || draft.vehicleNumber || 'не указан'}</span><select className="field-input" value={vehicleId} onChange={(event) => { setVehicleId(event.target.value); setCreateVehicle(false) }} disabled={createVehicle}><option value="">Выберите машину</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>LKW {vehicle.vehicleNumber}{vehicle.licensePlate ? ' · ' + vehicle.licensePlate : ''}</option>)}</select></label><label><span className="field-label">Номер Auftrag</span><input className="field-input" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} readOnly={!editing} /></label></div>{matchState.status !== 'MATCHED' ? <p className="quick-order-warning"><AlertTriangle className="h-4 w-4" />{matchState.status === 'AMBIGUOUS' ? 'Номер найден у нескольких машин.' : 'Машина из Auftrag не найдена.'} Выберите LKW или создайте новую.</p> : null}<label className="quick-create-vehicle"><input type="checkbox" checked={createVehicle} onChange={(event) => { setCreateVehicle(event.target.checked); if (event.target.checked) setVehicleId('') }} />Создать новую машину из Auftrag</label>{createVehicle ? <div className="quick-order-meta mt-2"><label><span className="field-label">Внутренний номер LKW</span><input className="field-input" value={newVehicleNumber} onChange={(event) => setNewVehicleNumber(event.target.value)} /></label><label><span className="field-label">Госномер</span><input className="field-input" value={newLicensePlate} onChange={(event) => setNewLicensePlate(event.target.value)} /></label></div> : null}{draft.trailerPlate ? <p className="quick-order-source">Прицеп: <strong>{draft.trailerPlate}</strong></p> : null}{draft.tourRemarks ? <p className="quick-order-source">Tourbemerkung{draft.tourRemarksSourcePage ? ' · стр. ' + draft.tourRemarksSourcePage : ''}: <strong>{draft.tourRemarks}</strong></p> : null}<div className="quick-order-stop-list">{stops.map((stop, index) => <article key={index} className="quick-order-review-stop"><div className="quick-order-review-title"><span>{index + 1}</span><strong>{stop.type === 'LOAD' ? 'Загрузка' : 'Выгрузка'}</strong>{stop.sourcePage ? <small>Стр. {stop.sourcePage}</small> : null}</div>{editing ? <div className="grid gap-3 md:grid-cols-2"><label className="md:col-span-2"><span className="field-label">Полный адрес</span><input className="field-input" value={stop.address} onChange={(event) => updateStop(index, { address: event.target.value })} /></label><label><span className="field-label">Город</span><input className="field-input" value={stop.city} onChange={(event) => updateStop(index, { city: event.target.value })} /></label><label><span className="field-label">Термин</span><input className="field-input" type="datetime-local" value={stop.appointmentLocal} onChange={(event) => updateStop(index, { appointmentLocal: event.target.value })} /></label><label><span className="field-label">LM, погрузочные метры</span><input className="field-input" value={stop.loadingMetersText} onChange={(event) => updateStop(index, { loadingMetersText: event.target.value })} /></label><label><span className="field-label">Референсы</span><input className="field-input" value={stop.referenceText} onChange={(event) => updateStop(index, { referenceText: event.target.value })} /></label><label className="md:col-span-2"><span className="field-label">Примечания</span><textarea className="field-input min-h-20" value={stop.instructionsText} onChange={(event) => updateStop(index, { instructionsText: event.target.value })} /></label></div> : <><p className="font-bold text-slate-900">{stop.address || 'Адрес не распознан'}</p><p className="text-sm text-slate-500">{stop.city || 'Город не указан'} · {formatAppointment(stop.appointmentLocal)}</p>{stop.resolution ? <p className={stop.resolution.precision === 'EXACT' && !stop.resolution.researchUsed ? 'quick-order-source' : 'quick-order-warning'}>{resolutionLabel(stop.resolution)}</p> : null}{stop.appointmentWindowStartLocal && stop.appointmentWindowEndLocal ? <p className="text-xs text-slate-600">Окно: {formatAppointment(stop.appointmentWindowStartLocal)} — {formatAppointment(stop.appointmentWindowEndLocal)}</p> : null}{stop.sourceExcerpt ? <p className="quick-order-source">Источник: {stop.sourceExcerpt}</p> : null}{cargoSummary(stop.loadingMeters, stop.referenceNumbers, stop.instructions)}</>}</article>)}</div>{draft.warnings.length ? <div className="quick-order-warning"><AlertTriangle className="h-4 w-4" /><span>{draft.warnings.map((warning) => warning.message).join(' · ')}</span></div> : null}{error ? <p className="quick-order-error"><AlertTriangle className="h-4 w-4" />{error}</p> : null}</div><footer><button type="button" className="secondary-button" onClick={() => setEditing((value) => !value)}><Pencil className="h-4 w-4" />{editing ? 'Завершить правки' : 'Редактировать'}</button><button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{busy ? 'Проверяем…' : 'Подтвердить'}</button></footer></section></div> : null}
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
function createImportAttemptId() {
  return globalThis.crypto?.randomUUID?.() ?? `import-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
async function createImportFingerprint(input: { fileName: string; orderNumber: string; trailerPlate?: string | null; stops: DraftStop[] }) {
  const canonical = JSON.stringify({
    fileName: input.fileName.trim().toLocaleLowerCase('de-DE'),
    orderNumber: input.orderNumber.trim().toLocaleUpperCase('de-DE'),
    trailerPlate: normalizeVehicle(input.trailerPlate ?? ''),
    stops: input.stops.map((stop) => ({
      type: stop.type,
      address: stop.address.trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' '),
      appointment: stop.appointmentLocal || null,
      references: splitReferences(stop.referenceText).map((value) => value.toLocaleUpperCase('de-DE'))
    }))
  })
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
    return `auftrag-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  let hash = 2166136261
  for (const character of canonical) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return `auftrag-${(hash >>> 0).toString(16).padStart(8, '0')}`
}
function resolutionLabel(resolution: AddressResolution) {
  if (resolution.researchUsed) return `ИИ нашёл вероятный полный адрес: ${resolution.resolvedAddress}. Проверьте перед подтверждением.`
  if (resolution.precision === 'EXACT') return `Точный адрес подтверждён: ${resolution.resolvedAddress}`
  if (resolution.precision === 'STREET') return `Найдена улица без подтверждённого номера дома: ${resolution.resolvedAddress}`
  if (resolution.precision === 'POSTCODE_CITY') return `Найдены только индекс и город: ${resolution.resolvedAddress}. ETA предварительная.`
  return `Используется центр города: ${resolution.resolvedAddress}. ETA предварительная.`
}
function cargoSummary(meters?: number | null, references?: string[] | null, instructions?: string | null) {
  if (!meters && !references?.length && !instructions) return null
  return <div className="quick-cargo"><span>{meters ? meters + ' LM' : 'LM не указан'}</span>{references?.length ? <span>Ref: {references.join(', ')}</span> : null}{instructions ? <p>{instructions}</p> : null}</div>
}
