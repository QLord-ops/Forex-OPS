import { UserCheck, UserMinus, UserPlus } from 'lucide-react'
import { useState } from 'react'

import { accountsApi, api } from '../lib/api'
import { currentDispatcher, currentDispatcherRole } from '../lib/auth'
import type { DashboardVehicle } from '../types/domain'

/** Who looks after the truck, with take / hand over / release. The server re-checks every rule. */
export function AssignmentBar({ row }: { row: DashboardVehicle }) {
  const me = currentDispatcher()
  const isAdmin = currentDispatcherRole() === 'admin'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [colleagues, setColleagues] = useState<Array<{ id: string; displayName: string }> | null>(null)
  if (!me && !isAdmin) return null
  const owner = row.assignedTo ?? null
  const expected = owner?.id ?? null

  async function change(input: { action: 'take' | 'release' | 'handover' | 'reassign'; toDispatcherId?: string | null }) {
    setBusy(true)
    setError('')
    try {
      await api.assignVehicle(row.vehicle.id, { ...input, expectedDispatcherId: expected })
      setColleagues(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось изменить.')
    } finally {
      setBusy(false)
      // Another dispatcher may have changed it meanwhile: refresh the list either way.
      window.dispatchEvent(new CustomEvent('ops:data-changed'))
    }
  }
  async function openHandover() {
    try { setColleagues((await accountsApi.directory()).filter((person) => person.id !== me?.id)) }
    catch { setError('Список коллег не загрузился.') }
  }

  return (
    <div className="assignment-bar" aria-live="polite">
      <span className="assignment-owner">
        <UserCheck className="h-4 w-4" aria-hidden="true" />
        {!owner ? 'Свободна' : row.mine ? 'Моя машина' : `Ведёт ${owner.name}`}
      </span>
      <span className="assignment-actions">
        {!owner && me ? <button type="button" className="assignment-button assignment-button-primary" disabled={busy} onClick={() => void change({ action: 'take' })}><UserPlus className="h-4 w-4" aria-hidden="true" />Взять себе</button> : null}
        {owner && !row.mine && isAdmin && me ? <button type="button" className="assignment-button" disabled={busy} onClick={() => { if (window.confirm(`Забрать машину у ${owner.name}?`)) void change({ action: 'reassign', toDispatcherId: me.id }) }}>Забрать себе</button> : null}
        {row.mine && colleagues === null ? <button type="button" className="assignment-button" disabled={busy} onClick={() => void openHandover()}>Передать</button> : null}
        {row.mine && colleagues !== null ? (
          <select className="assignment-select" aria-label="Передать коллеге" disabled={busy} defaultValue="" onChange={(event) => { if (event.target.value) void change({ action: 'handover', toDispatcherId: event.target.value }) }}>
            <option value="" disabled>{colleagues.length ? 'Кому передать…' : 'Нет других диспетчеров'}</option>
            {colleagues.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
          </select>
        ) : null}
        {owner && (row.mine || isAdmin) ? <button type="button" className="assignment-button" disabled={busy} onClick={() => void change({ action: row.mine ? 'release' : 'reassign', toDispatcherId: null })}><UserMinus className="h-4 w-4" aria-hidden="true" />Освободить</button> : null}
      </span>
      {error ? <p className="assignment-error" role="alert">{error}</p> : null}
    </div>
  )
}
