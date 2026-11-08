import { Smartphone } from 'lucide-react'
import { useEffect, useState } from 'react'

import { disablePush, enablePush, pushState, type PushState } from '../lib/push'

const NOTE: Record<PushState, string> = {
  on: 'включён',
  off: 'выключен',
  denied: 'запрещён в браузере',
  'not-configured': 'не настроен на сервере',
  unsupported: 'недоступен здесь (на iPhone — из приложения на экране «Домой»)'
}

/**
 * «Push на этот телефон»: decisions reach this device even when OPS is closed. Outside its working hours only urgent ones
 * ring. Switching it on asks the browser for permission; it switches off on logout.
 */
export function PushToggle({ className = '' }: { className?: string }) {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { let alive = true; void pushState().then((value) => { if (alive) setState(value) }); return () => { alive = false } }, [])
  const on = state === 'on'
  const available = state === 'on' || state === 'off'

  async function toggle() {
    setBusy(true); setError('')
    try { setState(on ? await disablePush() : await enablePush()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Push не включён.') }
    finally { setBusy(false) }
  }

  return <>
    <button type="button" className={`push-toggle ${className}`} role="switch" aria-checked={on} disabled={busy || !available} onClick={() => void toggle()}>
      <Smartphone className="h-5 w-5" aria-hidden="true" />
      <span className="more-item-label">Push на этот телефон</span>
      <span className="more-item-note">{state ? NOTE[state] : '…'}</span>
    </button>
    {error ? <p role="alert" className="push-toggle-error">{error}</p> : null}
  </>
}
