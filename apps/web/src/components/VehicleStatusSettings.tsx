import { useState } from 'react'

import { currentDispatcherRole } from '../lib/auth'
import { GROUP_LABEL, LINE_LABEL, statusApi, type StatusPresetCandidate } from '../lib/daily-status'
import type { StatusGroup, Vehicle, VehicleLine } from '../types/domain'

/** Line, block, service phone and A Schild / AppSped of one truck, saved on change: what the 07:00 status list uses. */
export function VehicleStatusCells({ vehicle, onSaved, withLine = true }: { vehicle: Vehicle; onSaved: () => void; withLine?: boolean }) {
  const [phone, setPhone] = useState(vehicle.servicePhone ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function save(input: Parameters<typeof statusApi.updateVehicle>[1]) {
    setBusy(true); setError('')
    try { await statusApi.updateVehicle(vehicle.id, input); onSaved() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не сохранено.') } finally { setBusy(false) }
  }
  const number = vehicle.vehicleNumber
  return <>
    {withLine ? <><td className="px-3 py-2">
      <select className="field-input h-8 min-w-32" aria-label={`Линия LKW ${number}`} disabled={busy} value={vehicle.line ?? ''}
        onChange={(event) => void save({ line: (event.target.value || null) as VehicleLine | null })}>
        <option value="">—</option>
        {(Object.keys(LINE_LABEL) as VehicleLine[]).map((line) => <option key={line} value={line}>{LINE_LABEL[line]}</option>)}
      </select>
    </td>
    <td className="px-3 py-2">
      <select className="field-input h-8 min-w-24" aria-label={`Группа в статусе LKW ${number}`} disabled={busy} value={vehicle.statusGroup ?? ''}
        onChange={(event) => void save({ statusGroup: (event.target.value || null) as StatusGroup | null })}>
        <option value="">—</option>
        {(Object.keys(GROUP_LABEL) as StatusGroup[]).map((group) => <option key={group} value={group}>{GROUP_LABEL[group]}</option>)}
      </select>
    </td></> : null}
    <td className="px-3 py-2">
      <input className="field-input h-8 min-w-36" aria-label={`Служебный телефон LKW ${number}`} title="Служебный номер машины — не личный номер водителя" inputMode="tel" maxLength={30}
        value={phone} disabled={busy} onChange={(event) => setPhone(event.target.value)}
        onBlur={() => { if (phone.trim() !== (vehicle.servicePhone ?? '')) void save({ servicePhone: phone.trim() || null }) }} />
      {error ? <span className="mt-1 block text-xs text-red-700" role="alert">{error}</span> : null}
    </td>
    <td className="px-3 py-2 text-center">
      <input type="checkbox" className="h-4 w-4" aria-label={`A Schild LKW ${number}`} checked={Boolean(vehicle.aSchild)} disabled={busy} onChange={(event) => void save({ aSchild: event.target.checked })} />
    </td>
    <td className="px-3 py-2 text-center">
      <input type="checkbox" className="h-4 w-4" aria-label={`AppSped LKW ${number}`} checked={Boolean(vehicle.appSped)} disabled={busy} onChange={(event) => void save({ appSped: event.target.checked })} />
    </td>
  </>
}

/** Admin only: mark the Webfleet trucks as the Schnellecke line in one step, after seeing exactly which ones. */
export function SchnelleckePreset({ onApplied }: { onApplied: () => void }) {
  const [candidates, setCandidates] = useState<StatusPresetCandidate[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  if (currentDispatcherRole() !== 'admin') return null

  async function open() {
    setBusy(true); setMessage('')
    try {
      const result = await statusApi.preset()
      setCandidates(result.candidates)
      setSelected(new Set(result.candidates.filter((item) => item.defaultSelected).map((item) => item.id)))
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Список не загрузился.') } finally { setBusy(false) }
  }
  async function apply() {
    setBusy(true); setMessage('')
    try {
      const result = await statusApi.applyPreset([...selected])
      setMessage(`Отмечено Schnellecke: ${result.changed}${result.skipped ? ` · пропущено (уже с линией): ${result.skipped}` : ''}`)
      setCandidates(null)
      onApplied()
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Не применено.') } finally { setBusy(false) }
  }

  return <div className="work-surface p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-slate-600">Линия Schnellecke получает автоматический статус в 07:00. Отметьте машины одним шагом: 727 и 2853 по умолчанию не отмечены, уже выбранная линия не меняется.</p>
      {!candidates ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void open()}>Отметить Schnellecke…</button> : null}
    </div>
    {candidates ? <fieldset className="space-y-2">
      <legend className="field-label">Машины с Webfleet</legend>
      <div className="flex flex-wrap gap-2">
        {candidates.map((item) => <label key={item.id} className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-sm">
          <input type="checkbox" checked={selected.has(item.id)} disabled={item.currentLine !== null}
            onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next })} />
          <span className="tabular-nums font-semibold">{item.vehicleNumber}</span>
          {item.currentLine ? <span className="text-xs text-slate-500">{LINE_LABEL[item.currentLine]}</span> : null}
        </label>)}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => setCandidates(null)}>Отмена</button>
        <button type="button" className="primary-button" disabled={busy || !selected.size} onClick={() => void apply()}>Отметить {selected.size} шт.</button>
      </div>
    </fieldset> : null}
    {message ? <p className="text-sm text-slate-700" role="status">{message}</p> : null}
  </div>
}
