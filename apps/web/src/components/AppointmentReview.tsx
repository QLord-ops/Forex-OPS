import { AlertTriangle, CalendarClock, CheckCircle2, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { api } from '../lib/api'
import { berlinLocalToIso } from '../lib/berlin-time'
import { formatDateTime } from '../lib/format'
import { sharedTerminNote } from '../lib/tours'
import type { AppointmentAnalysis, AppointmentDocument, AppointmentMatch } from '../types/domain'

const KIND_LABEL: Record<AppointmentDocument['kind'], string> = { VW_FAHRTENSCHEIN: 'Fahrtenschein', DECKBLATT: 'Deckblatt zur Warenanlieferung', OTHER: 'Термин' }
const RISK_LABEL: Record<AppointmentAnalysis['risk'], string> = { ON_TIME: 'Успевает', RISK: 'Риск опоздания', LATE: 'Опоздает', UNKNOWN: 'Без расчёта' }

/** Review of a recognised Termin slip. Nothing changes until the dispatcher presses «Применить». */
export function AppointmentReview({ document: initial, fingerprint, match: initialMatch, pendingId = null, alreadyApplied = false, fileName, onApplied, onSaved, onSkip }: {
  document: AppointmentDocument
  fingerprint: string
  match: AppointmentMatch
  pendingId?: string | null
  alreadyApplied?: boolean
  fileName?: string
  onApplied: (vehicleId: string) => void
  onSaved: () => void
  onSkip: () => void
}) {
  const [document, setDocument] = useState(initial)
  const [match, setMatch] = useState(initialMatch)
  const [stopId, setStopId] = useState(initialMatch.status === 'MATCHED' ? initialMatch.candidates[0]?.stopId ?? '' : '')
  const [mode, setMode] = useState<'exact' | 'window'>(initial.appointmentLocal ? 'exact' : 'window')
  const [preview, setPreview] = useState<AppointmentAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // A pair of one place is one candidate, the stop that keeps the Termin; a slip for the other operation alone goes to that one.
  const [split, setSplit] = useState<{ stopId: string; sequence: number; lead: number } | null>(null)
  const selected = match.candidates.find((candidate) => candidate.stopId === stopId) ?? null
  const slot = slotOf(document, mode)
  const place = preview && selected && preview.stopId === selected.stopId ? preview.sharedPlace : null
  const offer = split ?? (place && preview?.sharedStopIds?.length === 1 && (selected?.appointmentAt || selected?.windowStartAt)
    ? { stopId: preview.sharedStopIds[0], sequence: place.sequences[1], lead: place.sequences[0] }
    : null)
  const note = preview && selected && !split ? sharedTerminNote(preview.sharedPlace, false) : ''

  useEffect(() => {
    if (!selected || !slot) { setPreview(null); return }
    let current = true
    api.previewAppointmentSlot(split?.stopId ?? selected.stopId, slot, split ? 'STOP' : undefined).then((result) => { if (current) setPreview(result) }).catch(() => { if (current) setPreview(null) })
    return () => { current = false }
  // The slot is derived from these fields; a new object each render must not refetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.stopId, split?.stopId, slot?.appointmentAt, slot?.windowStartAt, slot?.windowEndAt])

  function patch(next: Partial<AppointmentDocument>) { setDocument((value) => ({ ...value, ...next })) }
  function cleaned(): AppointmentDocument {
    return { ...document, appointmentLocal: mode === 'exact' ? document.appointmentLocal : null, windowStartLocal: mode === 'window' ? document.windowStartLocal : null, windowEndLocal: mode === 'window' ? document.windowEndLocal : null }
  }

  async function rematch() {
    setBusy(true); setError('')
    try {
      const next = await api.matchAppointment(cleaned())
      setMatch(next)
      setSplit(null)
      setStopId(next.status === 'MATCHED' ? next.candidates[0]?.stopId ?? '' : '')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Поиск точки не удался.') } finally { setBusy(false) }
  }
  async function apply() {
    if (!selected || !slot) return
    setBusy(true); setError('')
    try {
      await api.applyAppointmentDocument({ stopId: split?.stopId ?? selected.stopId, version: preview?.version ?? selected.planVersion, fingerprint, pendingId, document: cleaned(), scope: split ? 'STOP' : undefined })
      onApplied(selected.vehicleId)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Термин не применён.') } finally { setBusy(false) }
  }
  async function savePending() {
    if (!slot) { setError('Укажите время термина.'); return }
    setBusy(true); setError('')
    try { await api.savePendingAppointment({ fingerprint, document: cleaned() }); onSaved() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Термин не сохранён.') } finally { setBusy(false) }
  }

  const vehicle = match.vehicle
  return <div className="dispatcher-review appointment-review">
    <section aria-label="Проверка термина">
      <header>
        <div className="min-w-0"><p>Проверка термина · {KIND_LABEL[document.kind]}</p><h2>{fileName || document.documentType || 'Термин'}</h2></div>
        <button type="button" className="icon-button" onClick={onSkip} aria-label="Пропустить термин"><X className="h-4 w-4" /></button>
      </header>
      <div className="quick-order-modal-body">
        {alreadyApplied ? <p className="quick-order-warning"><AlertTriangle className="h-4 w-4" />Этот документ уже применён к точке. Повторно применить его нельзя.</p> : null}
        {(document.warnings ?? []).map((warning) => <p key={warning.code} className="quick-order-warning"><AlertTriangle className="h-4 w-4" />{warning.message}</p>)}

        <div className="quick-order-meta">
          <label><span className="field-label">Номер машины из документа</span><input className="field-input" value={document.plate ?? ''} onChange={(event) => patch({ plate: event.target.value || null })} placeholder="не указан" /></label>
          <p className="appointment-review-vehicle" role="status">{vehicle.status === 'MATCHED' ? `LKW ${vehicle.vehicleNumber} найдена` : vehicle.status === 'NOT_FOUND' ? `LKW ${vehicle.plate} нет в OPS — ищем по месту` : 'Без номера — ищем по месту и номерам документа'}</p>
          <label><span className="field-label">Место (завод, получатель)</span><input className="field-input" value={document.company ?? ''} onChange={(event) => patch({ company: event.target.value || null })} /></label>
          <label><span className="field-label">Город</span><input className="field-input" value={document.city ?? ''} onChange={(event) => patch({ city: event.target.value || null })} /></label>
        </div>

        <fieldset className="appointment-review-time">
          <legend className="field-label">Время</legend>
          <div className="appointment-review-modes" role="radiogroup" aria-label="Вид термина">
            <label><input type="radio" name="termin-mode" checked={mode === 'exact'} onChange={() => setMode('exact')} />Точное время</label>
            <label><input type="radio" name="termin-mode" checked={mode === 'window'} onChange={() => setMode('window')} />Окно</label>
          </div>
          {mode === 'exact'
            ? <input className="field-input" type="datetime-local" aria-label="Время термина" value={document.appointmentLocal ?? ''} onChange={(event) => patch({ appointmentLocal: event.target.value || null })} />
            : <div className="grid grid-cols-2 gap-2">
              <input className="field-input" type="datetime-local" aria-label="Начало окна" value={document.windowStartLocal ?? ''} onChange={(event) => patch({ windowStartLocal: event.target.value || null })} />
              <input className="field-input" type="datetime-local" aria-label="Конец окна" value={document.windowEndLocal ?? ''} onChange={(event) => patch({ windowEndLocal: event.target.value || null })} />
            </div>}
        </fieldset>

        {document.references.length ? <p className="quick-order-source">Номера: {document.references.map((item) => `${item.label} ${item.value}`).join(' · ')}</p> : null}
        {document.positions?.length ? <p className="quick-order-source">Позиции: {document.positions.join(' · ')}</p> : null}
        {document.sourceExcerpt ? <p className="quick-order-source">Источник: {document.sourceExcerpt}</p> : null}

        <div className="appointment-review-stops">
          <div className="flex items-center justify-between gap-2">
            <strong>{match.status === 'MATCHED' ? 'Найдена точка' : match.status === 'AMBIGUOUS' ? 'Выберите точку' : 'Подходящей точки нет'}</strong>
            <button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => void rematch()}><RefreshCw className="h-4 w-4" />Найти заново</button>
          </div>
          {match.candidates.length ? <ul>
            {match.candidates.map((candidate) => <li key={candidate.stopId}>
              <label className={stopId === candidate.stopId ? 'appointment-review-stop appointment-review-stop-selected' : 'appointment-review-stop'}>
                <input type="radio" name="termin-stop" checked={stopId === candidate.stopId} onChange={() => { setStopId(candidate.stopId); setSplit(null) }} />
                <span className="min-w-0">
                  <strong>LKW {candidate.vehicleNumber} · {candidate.orderNumber} · {candidate.sequence}. {candidate.type === 'LOAD' ? 'Загрузка' : 'Выгрузка'}</strong>
                  <span>{[candidate.company, candidate.address].filter(Boolean).join(', ')}</span>
                  <span className="appointment-review-reasons">{candidate.reasons.join(' · ')}</span>
                  {candidate.appointmentAt || candidate.windowStartAt ? <span>Сейчас: {candidate.appointmentAt ? formatDateTime(candidate.appointmentAt) : `${formatDateTime(candidate.windowStartAt)}–${formatDateTime(candidate.windowEndAt)}`}</span> : null}
                </span>
              </label>
            </li>)}
          </ul> : <p className="quick-order-hint">Тура с этим местом пока нет. Сохраните термин как ожидающий — он сам предложится, когда придёт Auftrag.</p>}
        </div>

        {preview && selected ? <p className={`appointment-review-risk appointment-review-risk-${preview.risk.toLowerCase()}`} role="status">
          <CalendarClock className="h-4 w-4" aria-hidden="true" /><strong>{RISK_LABEL[preview.risk]}</strong>
          <span>{preview.recommendedStartAt ? `выехать до ${formatDateTime(preview.recommendedStartAt)}` : preview.message}</span>
        </p> : null}
        {note ? <p className="quick-order-hint">{note}</p> : null}
        {offer && selected ? <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={Boolean(split)} disabled={busy} onChange={(event) => setSplit(event.target.checked ? offer : null)} />
          <span>Только для точки {offer.sequence} — у неё свой Termin, у точки {offer.lead} остаётся прежний</span>
        </label> : null}
        {error ? <p className="quick-order-error" role="alert"><AlertTriangle className="h-4 w-4" />{error}</p> : null}
      </div>
      <footer>
        {!pendingId ? <button type="button" className="secondary-button" disabled={busy || alreadyApplied} onClick={() => void savePending()}>Сохранить как ожидающий</button> : null}
        <button type="button" className="primary-button" disabled={busy || !selected || !slot || alreadyApplied} onClick={() => void apply()}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Применить
        </button>
      </footer>
    </section>
  </div>
}

function slotOf(document: AppointmentDocument, mode: 'exact' | 'window') {
  if (mode === 'exact') return document.appointmentLocal ? { appointmentAt: berlinLocalToIso(document.appointmentLocal), windowStartAt: null, windowEndAt: null } : null
  return document.windowStartLocal && document.windowEndLocal && document.windowStartLocal <= document.windowEndLocal
    ? { appointmentAt: null, windowStartAt: berlinLocalToIso(document.windowStartLocal), windowEndAt: berlinLocalToIso(document.windowEndLocal) }
    : null
}
