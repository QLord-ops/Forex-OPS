import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, FileUp, LoaderCircle, MapPin, Pencil, Plus, Route, Search, Trash2, X } from 'lucide-react'
import type { ChangeEvent, DragEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../lib/api'
import { formatAppointment } from '../lib/format'
import type { MapRoutePreview } from '../lib/route-preview'
import { vehicleMatch } from '../lib/vehicle-match'
import { RouteBuilder } from './RouteBuilder'
import { AddressInput } from './AddressInput'
import { suggestionAddress, suggestionResolution, type AddressSuggestion } from '../lib/address-book'
import { AppointmentReview } from './AppointmentReview'
import { ImportCustomerNote, ImportCustomerSelect } from './ImportCustomer'
import { ConfidenceSummary, FieldNote, FieldNotes } from './FieldConfidence'
import { openCounts, orderViews, stateClass, stopViews, type StopField } from '../lib/field-confidence'
import { useImportCustomers } from '../hooks/useImportCustomers'
import { PendingAppointments } from './PendingAppointments'
import { pendingToDocument } from '../lib/appointments'
import type { AddressResolution, AppointmentDocument, AppointmentMatch, Coordinate, CreateTourStopInput, DashboardVehicle, ImportedOrderDraft, ImportedStopDraft, OrderImportPreview, PendingAppointment, Vehicle } from '../types/domain'
import { createImportAttemptId, importFingerprint } from '../lib/import-fingerprint'
import { berlinLocalToIso } from '../lib/berlin-time'

type DockTab = 'search' | 'route' | 'order'
type TerminReview = { document: AppointmentDocument; fingerprint: string; match: AppointmentMatch; pendingId: string | null; alreadyApplied: boolean; fileName: string }
type DraftStop = ImportedStopDraft & { city: string; company: string; address: string; appointmentLocal: string; loadingMetersText: string; referenceText: string; instructionsText: string; resolution?: AddressResolution | null
  /** What the import recognised, to notice the dispatcher's correction. */
  original?: { company: string; address: string; city: string; type?: string; time?: string; loadingMeters?: string; references?: string }
  /** Position in the recognised draft; stops the dispatcher added have none. */
  draftStopIndex?: number | null }

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
  onRoutePreview?: (preview: MapRoutePreview | null) => void
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
  const [termin, setTermin] = useState<TerminReview | null>(null)
  const [pendingVersion, setPendingVersion] = useState(0)
  const [stops, setStops] = useState<DraftStop[]>(cachedImport?.stops ?? [])
  const [vehicleId, setVehicleId] = useState(cachedImport?.vehicleId ?? '')
  const [orderNumber, setOrderNumber] = useState(cachedImport?.orderNumber ?? '')
  const [editing, setEditing] = useState(cachedImport?.editing ?? false)
  const [createVehicle, setCreateVehicle] = useState(cachedImport?.createVehicle ?? false)
  const [newVehicleNumber, setNewVehicleNumber] = useState(cachedImport?.newVehicleNumber ?? '')
  const [newLicensePlate, setNewLicensePlate] = useState(cachedImport?.newLicensePlate ?? '')
  const [importAttemptId, setImportAttemptId] = useState(cachedImport?.importAttemptId ?? createImportAttemptId())
  /** Fields in doubt the dispatcher confirmed with «Верно» (key: recognised stop index and field). */
  const [verified, setVerified] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResult, setSearchResult] = useState('')
  const selectedVehicleNumber = row?.vehicle.vehicleNumber
  const importCustomers = useImportCustomers(row?.customer?.id ?? null)
  const addressRequest = useRef(0)
  const matchState = useMemo(() => vehicleMatch(draft?.vehiclePlate || draft?.vehicleNumber, vehicles), [draft?.vehiclePlate, draft?.vehicleNumber, vehicles])
  const verifiedSet = useMemo(() => new Set(verified), [verified])
  const stopFieldViews = useMemo(() => stopViews(stops.map((stop) => ({
    draftStopIndex: stop.draftStopIndex, fieldConfidence: stop.fieldConfidence, geocodePrecision: stop.resolution?.precision,
    values: { type: stop.type, company: stop.company, address: stop.address, city: stop.city, time: stop.appointmentLocal || stop.appointmentWindowStartLocal || '', loadingMeters: stop.loadingMetersText, references: stop.referenceText },
    original: stop.original
  })), verifiedSet), [stops, verifiedSet])
  const orderFieldViews = useMemo(() => orderViews(draft?.orderConfidence, { orderNumber }, { orderNumber: draft?.orderNumber ?? '' }, verifiedSet), [draft, orderNumber, verifiedSet])
  const fieldCounts = openCounts([...stopFieldViews.flat(), ...orderFieldViews])
  const fieldView = (index: number, field: StopField) => stopFieldViews[index]?.find((view) => view.field === field)
  const verify = (key: string) => setVerified((current) => current.includes(key) ? current : [...current, key])

  useEffect(() => {
    if (!importOnly) return
    try { sessionStorage.setItem('ops-assistant-import-v1', JSON.stringify({ draft, stops, vehicleId, orderNumber, fileName, pendingDrafts, editing, createVehicle, newVehicleNumber, newLicensePlate, importAttemptId })) } catch { /* Storage may be unavailable. */ }
  }, [importOnly, draft, stops, vehicleId, orderNumber, fileName, pendingDrafts, editing, createVehicle, newVehicleNumber, newLicensePlate, importAttemptId])

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
          next.push({ ...stop, resolution: await api.resolveAddress({ address: stop.address.trim(), city: stop.city.trim() || null, company: stop.company.trim() || null }) })
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
    if (draft || termin || busy) setPendingFiles((current) => [...current, ...supported])
    else { void analyze(supported[0]); setPendingFiles((current) => [...current, ...supported.slice(1)]) }
  }

  async function analyze(file: File) {
    setError(''); setBusy(true); setFileName(file.name)
    try {
      const kind = classifyFile(file)
      const customerId = importCustomers.customerId
      const result = kind === 'PDF' ? await api.importPdf(file, customerId) : kind === 'EXCEL' ? await api.importExcel(file, customerId) : kind === 'IMAGE' ? await api.importImage(file, customerId) : null
      // A Termin slip goes to its own review: it changes the time of an existing stop, it creates no tour.
      if (result?.documentKind === 'APPOINTMENT' && result.appointment?.fingerprint && result.match) {
        setTermin({ document: result.appointment, fingerprint: result.appointment.fingerprint, match: result.match, pendingId: result.previous?.status === 'PENDING' ? result.previous.id : null,
          alreadyApplied: result.previous?.status === 'ATTACHED', fileName: file.name })
        setTab('order')
        return
      }
      if (!result?.drafts.length) throw new Error('В файле не найден ни Auftrag, ни термин.')
      const drafts = draftsOf(result)
      setPendingDrafts((current) => [...current, ...drafts.slice(1).map((item) => ({ draft: item, fileName: file.name }))])
      openDraft(drafts[0])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось распознать Auftrag.')
    } finally { setBusy(false) }
  }

  function openDraft(next: ImportedOrderDraft) {
    const match = vehicleMatch(next.vehiclePlate || next.vehicleNumber, vehicles)
    setImportAttemptId(createImportAttemptId())
    setDraft(next); setOrderNumber(next.orderNumber ?? ''); setVehicleId(match.id ?? ''); setVerified([])
    setCreateVehicle(false)
    setNewVehicleNumber(next.vehicleNumber && !looksLikePlate(next.vehicleNumber) ? next.vehicleNumber : '')
    setNewLicensePlate(next.vehiclePlate || (next.vehicleNumber && looksLikePlate(next.vehicleNumber) ? next.vehicleNumber : ''))
    setStops(next.stops.slice().sort((a, b) => a.sequence - b.sequence).map((item, index) => toDraftStop(item, index)))
    setEditing(false); setTab('order')
  }

  /** The stored file read again for another customer; the other Auftrag of the same file follow in the queue. */
  async function reparse(customerId: string | null) {
    const documentId = draft?.documentId
    if (!documentId) return
    setError(''); setBusy(true)
    try {
      const drafts = draftsOf(await api.reparseDocument(documentId, customerId))
      if (!drafts.length) throw new Error('В файле не найден Auftrag.')
      const index = Math.max(0, drafts.findIndex((item) => item.orderNumber && item.orderNumber === draft?.orderNumber))
      setPendingDrafts((current) => [...current.filter((item) => item.draft.documentId !== documentId), ...drafts.filter((_, position) => position !== index).map((item) => ({ draft: item, fileName }))])
      openDraft(drafts[index])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось разобрать Auftrag заново.')
    } finally { setBusy(false) }
  }

  function nextFile() {
    setDraft(null); setTermin(null); setEditing(false); setImportAttemptId(createImportAttemptId()); setVerified([])
    const queued = pendingDrafts[0]
    if (queued) {
      setPendingDrafts((current) => current.slice(1)); setDraft(queued.draft); setFileName(queued.fileName); setOrderNumber(queued.draft.orderNumber ?? ''); setVehicleId(vehicleMatch(queued.draft.vehiclePlate || queued.draft.vehicleNumber, vehicles).id ?? ''); setStops(queued.draft.stops.slice().sort((a, b) => a.sequence - b.sequence).map((item, index) => toDraftStop(item, index))); setCreateVehicle(false); setNewVehicleNumber(queued.draft.vehicleNumber ?? ''); setNewLicensePlate(queued.draft.vehiclePlate ?? ''); return
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
        : await api.resolveAddress({ address: stop.address.trim(), city: stop.city?.trim() || null, company: stop.company?.trim() || null })
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
        appointmentAt: stop.appointmentLocal ? berlinLocalToIso(stop.appointmentLocal) : null,
        appointmentWindowStartAt: stop.appointmentWindowStartLocal ? berlinLocalToIso(stop.appointmentWindowStartLocal) : null,
        appointmentWindowEndAt: stop.appointmentWindowEndLocal ? berlinLocalToIso(stop.appointmentWindowEndLocal) : null,
        plannedAt: 'plannedLocal' in stop && stop.plannedLocal && !stop.appointmentLocal ? berlinLocalToIso(stop.plannedLocal as string) : null,
        learnLabel: correctedLabel(stop as DraftStop),
        draftStopIndex: 'draftStopIndex' in stop ? (stop as DraftStop).draftStopIndex ?? null : null,
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
    if (fieldCounts.doubt) { setError(`Под сомнением: ${fieldCounts.doubt}. Исправьте эти поля или отметьте «Верно».`); return }
    if ((!vehicleId && !createVehicle) || (createVehicle && !newVehicleNumber.trim()) || !orderNumber.trim() || stops.length < 2 || stops.some((stop) => !stop.address.trim())) {
      setEditing(true); setError('Выберите или создайте LKW, укажите номер Auftrag и заполните адреса минимум двух точек.'); return
    }
    const planProblem = stops[0]?.type !== 'LOAD' ? 'Первая точка тура должна быть загрузкой.'
      : !stops.some((stop) => stop.type === 'UNLOAD') ? 'В туре нет ни одной выгрузки.'
        : stops.some((stop) => !stop.city.trim()) ? 'У каждой точки должен быть город.' : ''
    if (planProblem) { setEditing(true); setError(planProblem); return }
    setBusy(true); setError('')
    try {
      const resolved = await resolveStops(stops)
      const metadata = { trailerPlate: draft?.trailerPlate || undefined, tourRemarks: draft?.tourRemarks || undefined, documentId: draft?.documentId ?? null }
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

  // The dispatcher completes the recognised plan: add, remove, reorder a stop or switch it between loading and unloading.
  function addStop(type: 'LOAD' | 'UNLOAD') {
    setStops((current) => {
      const stop: DraftStop = { sequence: current.length + 1, type, company: '', address: '', city: '', appointmentLocal: '', loadingMetersText: '', referenceText: '', instructionsText: '', confidence: 1 }
      // A new loading goes after the last loading, a new unloading at the end.
      const at = type === 'LOAD' ? current.reduce((last, item, index) => item.type === 'LOAD' ? index + 1 : last, 0) : current.length
      return renumber([...current.slice(0, at), stop, ...current.slice(at)])
    })
  }
  function removeStop(index: number) { setStops((current) => renumber(current.filter((_, stopIndex) => stopIndex !== index))) }
  function moveStop(index: number, delta: -1 | 1) {
    setStops((current) => {
      const target = index + delta
      if (target < 0 || target >= current.length) return current
      const next = current.slice()
      ;[next[index], next[target]] = [next[target], next[index]]
      return renumber(next)
    })
  }
  function pickAddress(index: number, item: AddressSuggestion) {
    const resolution = suggestionResolution(item)
    setStops((current) => current.map((stop, stopIndex) => stopIndex === index
      ? { ...stop, company: item.company ?? stop.company, address: resolution.sourceAddress, city: item.city ?? stop.city, resolution } : stop))
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
        {tab === 'search' ? <div className="map-action-content"><label className="field-label" htmlFor="map-search-address">Полный адрес или город</label><div className="flex gap-2"><AddressInput id="map-search-address" className="field-input min-w-0" value={searchQuery} onChange={setSearchQuery} onKeyDown={(event) => { if (event.key === 'Enter') void findAddress() }} placeholder="Фирма, улица или город"
              onPick={(item) => { setSearchQuery(item.label); setSearchResult(`${item.label}, ${suggestionAddress(item)}`); setError(''); onAddressFound?.([item.longitude, item.latitude]) }} onFreeSearch={() => void findAddress()} /><button type="button" className="primary-button" onClick={() => void findAddress()} disabled={busy}><Search className="h-4 w-4" /></button></div>{searchResult ? <p className="map-action-result"><MapPin className="h-4 w-4" />{searchResult}</p> : null}</div> : null}
        {tab === 'route' ? <RouteBuilder vehicles={vehicles} selectedVehicleNumber={selectedVehicleNumber} onPreview={(preview) => onRoutePreview?.(preview)} /> : null}
        {tab === 'order' ? <div className="map-action-content"><ImportCustomerSelect customers={importCustomers.customers} value={importCustomers.customerId} onChange={importCustomers.setCustomerId} disabled={busy} /><div className={'quick-order-drop ' + (dragging ? 'dragging' : '')} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}><FileUp className="h-7 w-7" /><strong>{busy ? 'Распознаём Auftrag…' : 'Перетащите Auftrag сюда'}</strong><span>PDF, Excel или скриншот</span><label className="secondary-button cursor-pointer">Выбрать файлы<input className="sr-only" type="file" multiple accept=".pdf,.xlsx,.png,.jpg,.jpeg,.webp" onChange={onFileInput} disabled={busy} /></label></div><p className="quick-order-hint">Каждый заказ проверяется отдельно. В очереди: {pendingDrafts.length + pendingFiles.length}. Файл сохраняется вместе с туром.</p><PendingAppointments version={pendingVersion} onReview={(item: PendingAppointment) => { if (!draft && !termin) setTermin({ document: pendingToDocument(item), fingerprint: item.fingerprint, match: item.match, pendingId: item.id, alreadyApplied: false, fileName: 'Ожидающий термин' }) }} /></div> : null}
        {error && !draft ? <p className="quick-order-error"><AlertTriangle className="h-4 w-4" />{error}</p> : null}
      </div> : null}
    </aside>
    {termin ? <AppointmentReview key={termin.fingerprint} document={termin.document} fingerprint={termin.fingerprint} match={termin.match} pendingId={termin.pendingId}
      alreadyApplied={termin.alreadyApplied} fileName={termin.fileName}
      onApplied={(appliedVehicleId) => { setPendingVersion((value) => value + 1); void onCreated(appliedVehicleId); nextFile() }}
      onSaved={() => { setPendingVersion((value) => value + 1); nextFile() }} onSkip={nextFile} /> : null}
    {draft ? <div className="dispatcher-review"><section aria-label="Проверка Auftrag"><header><div className="min-w-0"><p>Проверка распознавания</p><h2>{fileName}</h2></div><button type="button" className="icon-button" onClick={nextFile} aria-label="Пропустить текущий заказ"><X className="h-4 w-4" /></button></header><div className="quick-order-modal-body"><ImportCustomerNote customer={draft.customer} customers={importCustomers.customers} busy={busy} canReparse={Boolean(draft.documentId)} onReparse={(customerId) => void reparse(customerId)} /><ConfidenceSummary doubt={fieldCounts.doubt} check={fieldCounts.check} /><FieldNotes views={orderFieldViews} onVerify={verify} /><div className="quick-order-meta"><label><span className="field-label">LKW из документа: {draft.vehiclePlate || draft.vehicleNumber || 'не указан'}</span><select className="field-input" value={vehicleId} onChange={(event) => { setVehicleId(event.target.value); setCreateVehicle(false) }} disabled={createVehicle}><option value="">Выберите машину</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>LKW {vehicle.vehicleNumber}{vehicle.licensePlate ? ' · ' + vehicle.licensePlate : ''}</option>)}</select></label><label className={stateClass(orderFieldViews.find((view) => view.field === 'orderNumber'))}><span className="field-label">Номер Auftrag</span><input className="field-input" value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} readOnly={!editing} /></label></div>{matchState.status !== 'MATCHED' ? <p className="quick-order-warning"><AlertTriangle className="h-4 w-4" />{matchState.status === 'AMBIGUOUS' ? 'Номер найден у нескольких машин.' : 'Машина из Auftrag не найдена.'} Выберите LKW или создайте новую.</p> : null}<label className="quick-create-vehicle"><input type="checkbox" checked={createVehicle} onChange={(event) => { setCreateVehicle(event.target.checked); if (event.target.checked) setVehicleId('') }} />Создать новую машину из Auftrag</label>{createVehicle ? <div className="quick-order-meta mt-2"><label><span className="field-label">Внутренний номер LKW</span><input className="field-input" value={newVehicleNumber} onChange={(event) => setNewVehicleNumber(event.target.value)} /></label><label><span className="field-label">Госномер</span><input className="field-input" value={newLicensePlate} onChange={(event) => setNewLicensePlate(event.target.value)} /></label></div> : null}{draft.trailerPlate ? <p className="quick-order-source">Прицеп: <strong>{draft.trailerPlate}</strong></p> : null}{draft.tourRemarks ? <p className="quick-order-source">Tourbemerkung{draft.tourRemarksSourcePage ? ' · стр. ' + draft.tourRemarksSourcePage : ''}: <strong>{draft.tourRemarks}</strong></p> : null}<div className="quick-order-stop-list">{stops.map((stop, index) => <article key={index} className={'quick-order-review-stop' + (stopFieldViews[index]?.some((view) => view.state === 'DOUBT') ? ' field-stop-doubt' : '')}><div className="quick-order-review-title"><span>{index + 1}</span>{editing ? <select className="field-input quick-stop-type" aria-label={`Тип точки ${index + 1}`} value={stop.type} onChange={(event) => updateStop(index, { type: event.target.value as 'LOAD' | 'UNLOAD' })}><option value="LOAD">Загрузка</option><option value="UNLOAD">Выгрузка</option></select> : <strong>{stop.type === 'LOAD' ? 'Загрузка' : 'Выгрузка'}</strong>}{stop.sourcePage ? <small>Стр. {stop.sourcePage}</small> : null}{editing ? <span className="quick-stop-tools"><button type="button" className="icon-button icon-button-compact" onClick={() => moveStop(index, -1)} disabled={index === 0} aria-label={`Точку ${index + 1} выше`}><ArrowUp className="h-3.5 w-3.5" /></button><button type="button" className="icon-button icon-button-compact" onClick={() => moveStop(index, 1)} disabled={index === stops.length - 1} aria-label={`Точку ${index + 1} ниже`}><ArrowDown className="h-3.5 w-3.5" /></button></span> : null}</div>{editing ? <FieldNote view={fieldView(index, 'type')} onVerify={verify} /> : null}{editing ? <div className="grid gap-3 md:grid-cols-2"><div className={'md:col-span-2 ' + stateClass(fieldView(index, 'company'))}><label className="block"><span className="field-label">Фирма</span><input className="field-input" value={stop.company} onChange={(event) => updateStop(index, { company: event.target.value })} placeholder="Например, BLG Industrielogistik" /></label><FieldNote view={fieldView(index, 'company')} onVerify={verify} withLabel={false} /></div><div className={'md:col-span-2 ' + stateClass(fieldView(index, 'address'))}><label className="block"><span className="field-label">Полный адрес</span><AddressInput value={stop.address} onChange={(value) => updateStop(index, { address: value })} placeholder="Фирма, улица или город"
            onPick={(item) => pickAddress(index, item)} /></label><FieldNote view={fieldView(index, 'address')} onVerify={verify} withLabel={false} /></div><div className={stateClass(fieldView(index, 'city'))}><label className="block"><span className="field-label">Город</span><input className="field-input" value={stop.city} onChange={(event) => updateStop(index, { city: event.target.value })} /></label><FieldNote view={fieldView(index, 'city')} onVerify={verify} withLabel={false} /></div><div className={stateClass(fieldView(index, 'time'))}><label className="block"><span className="field-label">Термин</span><input className="field-input" type="datetime-local" value={stop.appointmentLocal} onChange={(event) => updateStop(index, event.target.value ? { appointmentLocal: event.target.value, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null } : { appointmentLocal: '' })} /></label><FieldNote view={fieldView(index, 'time')} onVerify={verify} withLabel={false} /></div><div className={stateClass(fieldView(index, 'loadingMeters'))}><label className="block"><span className="field-label">LM, погрузочные метры</span><input className="field-input" value={stop.loadingMetersText} onChange={(event) => updateStop(index, { loadingMetersText: event.target.value })} /></label><FieldNote view={fieldView(index, 'loadingMeters')} onVerify={verify} withLabel={false} /></div><div className={stateClass(fieldView(index, 'references'))}><label className="block"><span className="field-label">Референсы</span><input className="field-input" value={stop.referenceText} onChange={(event) => updateStop(index, { referenceText: event.target.value })} /></label><FieldNote view={fieldView(index, 'references')} onVerify={verify} withLabel={false} /></div><label className="md:col-span-2"><span className="field-label">Примечания</span><textarea className="field-input min-h-20" value={stop.instructionsText} onChange={(event) => updateStop(index, { instructionsText: event.target.value })} /></label><div className="md:col-span-2"><button type="button" className="danger-button" onClick={() => removeStop(index)} aria-label={`Удалить точку ${index + 1}`}><Trash2 className="h-4 w-4" />Удалить {stop.type === 'LOAD' ? 'загрузку' : 'выгрузку'}</button></div></div> : <><p className="font-bold text-slate-900">{stop.address || 'Адрес не распознан'}</p><p className="text-sm text-slate-500">{[stop.company, stop.city || 'Город не указан'].filter(Boolean).join(' · ')} · {stop.appointmentLocal ? formatAppointment(stop.appointmentLocal) : stop.plannedLocal ? `план ${formatAppointment(stop.plannedLocal)}, не Termin` : formatAppointment(stop.appointmentLocal)}</p>{stop.terminRequired && !stop.appointmentLocal && !stop.appointmentWindowStartLocal ? <p className="termin-needed">Termin нужен — придёт отдельно</p> : null}{stop.resolution ? <p className={stop.resolution.precision === 'EXACT' && !stop.resolution.researchUsed ? 'quick-order-source' : 'quick-order-warning'}>{resolutionLabel(stop.resolution)}</p> : null}{stop.appointmentWindowStartLocal && stop.appointmentWindowEndLocal ? <p className="text-xs text-slate-600">Окно: {formatAppointment(stop.appointmentWindowStartLocal)} — {formatAppointment(stop.appointmentWindowEndLocal)}</p> : null}<FieldNotes views={stopFieldViews[index] ?? []} onVerify={verify} />{stop.sourceExcerpt ? <p className="quick-order-source">Источник: {stop.sourceExcerpt}</p> : null}{cargoSummary(stop.loadingMeters, stop.referenceNumbers, stop.instructions)}</>}</article>)}</div>{editing ? <div className="quick-stop-add"><button type="button" className="secondary-button" onClick={() => addStop('LOAD')}><Plus className="h-4 w-4" />Загрузка</button><button type="button" className="secondary-button" onClick={() => addStop('UNLOAD')}><Plus className="h-4 w-4" />Выгрузка</button></div> : null}{draft.warnings.length ? <div className="quick-order-warning"><AlertTriangle className="h-4 w-4" /><span>{draft.warnings.map((warning) => warning.message).join(' · ')}</span></div> : null}{error ? <p className="quick-order-error"><AlertTriangle className="h-4 w-4" />{error}</p> : null}</div><footer><button type="button" className="secondary-button" onClick={() => setEditing((value) => !value)}><Pencil className="h-4 w-4" />{editing ? 'Завершить правки' : 'Редактировать'}</button>{fieldCounts.doubt ? <p className="field-gate">Под сомнением: {fieldCounts.doubt}. Исправьте или отметьте «Верно».</p> : null}<button type="button" className="primary-button" disabled={busy || fieldCounts.doubt > 0} onClick={() => void confirm()}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{busy ? 'Проверяем…' : 'Подтвердить'}</button></footer></section></div> : null}
  </>
}

/** Drafts of one upload with the file and customer they belong to; the file-level notes go with the first one. */
function draftsOf(result: OrderImportPreview): ImportedOrderDraft[] {
  const documentId = result.documentId ?? null
  const customer = result.customer ?? null
  const shared = result.warnings.filter((warning) => warning.code === 'DOCUMENT_ALREADY_ATTACHED' || warning.code.startsWith('CUSTOMER_'))
  return result.drafts.map((item, index) => ({ ...item, documentId, customer, warnings: index === 0 ? [...shared, ...item.warnings] : item.warnings }))
}

function toDraftStop(stop: ImportedStopDraft, draftStopIndex: number): DraftStop { return { ...stop, draftStopIndex, city: stop.city ?? '', company: stop.company ?? '', address: stop.address ?? '', appointmentLocal: stop.appointmentLocal ?? '', loadingMetersText: stop.loadingMeters?.toString() ?? '', referenceText: stop.referenceNumbers?.join(', ') ?? '', instructionsText: stop.instructions ?? '',
  original: { company: stop.company ?? '', address: stop.address ?? '', city: stop.city ?? '', type: stop.type, time: stop.appointmentLocal || stop.appointmentWindowStartLocal || '', loadingMeters: stop.loadingMeters?.toString() ?? '', references: stop.referenceNumbers?.join(', ') ?? '' } } }

/** The imported label when the dispatcher changed the place: the server remembers the corrected address for it. */
function correctedLabel(stop: DraftStop): string | null {
  if (!stop.sourceLabel || !stop.original) return null
  const changed = (left: string, right: string) => left.trim().toLocaleLowerCase('de-DE') !== right.trim().toLocaleLowerCase('de-DE')
  return changed(stop.address, stop.original.address) || changed(stop.company, stop.original.company) || changed(stop.city, stop.original.city) ? stop.sourceLabel : null
}
function splitReferences(value: string) { return value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean).slice(0, 20) }
function normalizeVehicle(value: string) { return value.toLocaleUpperCase('de-DE').replace(/[^A-ZА-Я0-9]/g, '') }
function looksLikePlate(value: string) { return /[A-ZА-Я]+[- ]?[A-ZА-Я0-9]+[- ]?[0-9]+/i.test(value) }
function classifyFile(file: File): 'PDF' | 'EXCEL' | 'IMAGE' | 'UNKNOWN' {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) return 'PDF'
  if (name.endsWith('.xlsx')) return 'EXCEL'
  if (/[.](png|jpe?g|webp)$/.test(name)) return 'IMAGE'
  return 'UNKNOWN'
}
async function createImportFingerprint(input: { fileName: string; orderNumber: string; trailerPlate?: string | null; stops: DraftStop[] }) {
  return importFingerprint({
    fileName: input.fileName.trim().toLocaleLowerCase('de-DE'),
    orderNumber: input.orderNumber.trim().toLocaleUpperCase('de-DE'),
    trailerPlate: normalizeVehicle(input.trailerPlate ?? ''),
    stops: input.stops.map((stop) => ({
      type: stop.type,
      address: stop.address.trim().toLocaleLowerCase('de-DE').replace(/\s+/g, ' '),
      appointment: stop.appointmentLocal || stop.appointmentWindowStartLocal || null,
      references: splitReferences(stop.referenceText).map((value) => value.toLocaleUpperCase('de-DE'))
    }))
  })
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

function renumber<T extends { sequence: number }>(stops: T[]): T[] { return stops.map((stop, index) => ({ ...stop, sequence: index + 1 })) }
