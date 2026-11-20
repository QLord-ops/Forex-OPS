import { Home } from 'lucide-react'
import { useState } from 'react'

import { api } from '../lib/api'
import { baseChip } from '../lib/base-visit'
import type { BaseVisit } from '../types/domain'

/** The truck's week at the base in its card: the deadline in words, and the arrival by hand when GPS did not see it. */
export function BaseVisitBar({ visit }: { visit: BaseVisit }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chip = baseChip(visit)
  if (!chip) return null
  const atBase = visit.state === 'AT_BASE'

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось записать.') }
    finally { setBusy(false); window.dispatchEvent(new CustomEvent('ops:data-changed')) }
  }

  return <div className="assignment-bar" aria-live="polite">
    <span className="assignment-owner" title={chip.title}>
      <Home className="h-4 w-4" aria-hidden="true" />
      {atBase ? `На базе, снова работает ${chip.label.replace('на базе до ', 'с ')}` : chip.label.replace(/^на базу/, 'На базу')}
    </span>
    <span className="assignment-actions">
      {atBase
        ? <button type="button" className="assignment-button" disabled={busy} onClick={() => void run(() => api.revertAtBase(visit.id))}>Отменить заезд</button>
        : <button type="button" className="assignment-button" disabled={busy} onClick={() => void run(() => api.markAtBase(visit.id))}>Уже на базе</button>}
    </span>
    {!atBase && chip.title ? <p className="page-subtitle w-full">{chip.title}</p> : null}
    {error ? <p className="quick-order-error w-full" role="alert">{error}</p> : null}
  </div>
}
