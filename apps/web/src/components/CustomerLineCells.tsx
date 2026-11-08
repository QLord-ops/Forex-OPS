import { useState } from 'react'

import { customersApi, type Customer, type DispatcherAccount } from '../lib/api'
import { lineOptions } from '../lib/customers'
import type { Vehicle } from '../types/domain'

/** The customer line of one truck, saved on change; replaces the old line + block selects once customers exist. */
export function CustomerLineSelect({ vehicle, customers, onSaved }: { vehicle: Vehicle; customers: Customer[]; onSaved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function change(lineId: string | null) {
    setBusy(true); setError('')
    try { await customersApi.setVehicleLine(vehicle.id, lineId); onSaved() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не сохранено.') } finally { setBusy(false) }
  }
  return <td className="px-3 py-2">
    <select className="field-input h-8 min-w-48" aria-label={`Линия заказчика LKW ${vehicle.vehicleNumber}`} disabled={busy} value={vehicle.customerLineId ?? ''}
      onChange={(event) => void change(event.target.value || null)}>
      <option value="">— без линии —</option>
      {lineOptions(customers).map((group) => <optgroup key={group.customer.id} label={group.customer.name}>
        {group.lines.map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}
      </optgroup>)}
    </select>
    {error ? <span className="mt-1 block text-xs text-red-700" role="alert">{error}</span> : null}
  </td>
}

/** Admin: the lines a dispatcher works on, with the primary line that sets the default customer of an import. */
export function DispatcherLinesEditor({ account, customers, onSaved }: { account: DispatcherAccount; customers: Customer[]; onSaved: (message: string) => void }) {
  const current = account.lines ?? []
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set(current.map((line) => line.lineId)))
  const [primary, setPrimary] = useState<string | null>(current.find((line) => line.isPrimary)?.lineId ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const names = new Map(customers.flatMap((customer) => customer.lines.map((line) => [line.id, `${customer.name} · ${line.name}`] as const)))
  const summary = current.length ? current.map((line) => `${names.get(line.lineId) ?? '—'}${line.isPrimary && current.length > 1 ? ' (основная)' : ''}`).join(', ') : 'нет линий'

  async function save() {
    setBusy(true); setError('')
    try {
      const ids = [...selected]
      await customersApi.setDispatcherLines(account.id, ids, primary && selected.has(primary) ? primary : ids[0] ?? null)
      setOpen(false); onSaved(`Линии ${account.displayName} сохранены.`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не сохранено.') } finally { setBusy(false) }
  }

  if (!open) return <div className="text-sm">
    <span>{summary}</span>
    {customers.length ? <button type="button" className="ml-2 text-xs text-blue-700 underline" onClick={() => setOpen(true)} aria-label={`Изменить линии ${account.displayName}`}>изменить</button> : null}
  </div>
  return <fieldset className="space-y-2 text-sm">
    <legend className="sr-only">Линии {account.displayName}</legend>
    {lineOptions(customers).map((group) => <div key={group.customer.id}>
      <span className="text-xs font-medium text-slate-500">{group.customer.name}</span>
      {group.lines.map((line) => <div key={line.id} className="flex items-center gap-3">
        <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={selected.has(line.id)}
          onChange={(event) => setSelected((value) => { const next = new Set(value); if (event.target.checked) next.add(line.id); else next.delete(line.id); return next })} />{line.label.replace(`${group.customer.name} · `, '')}</label>
        {selected.has(line.id) ? <label className="inline-flex items-center gap-1 text-xs text-slate-500"><input type="radio" name={`primary-${account.id}`} checked={primary === line.id} onChange={() => setPrimary(line.id)} />основная</label> : null}
      </div>)}
    </div>)}
    <div className="flex gap-2">
      <button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => setOpen(false)}>Отмена</button>
      <button type="button" className="primary-button compact-button" disabled={busy} onClick={() => void save()}>Сохранить</button>
    </div>
    {error ? <p className="text-xs text-red-700" role="alert">{error}</p> : null}
  </fieldset>
}
