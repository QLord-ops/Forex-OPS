import { KeyRound, UserRound, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { accountsApi } from '../lib/api'
import { currentDispatcher } from '../lib/auth'

const MIN_PASSWORD = 12

/** Who is signed in, plus changing one's own password. Shared-password sessions show nothing here. */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const person = currentDispatcher()
  const [open, setOpen] = useState(false)
  if (!person) return null
  const initials = person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'
  return <>
    <button type="button" className={compact ? 'account-menu account-menu-compact' : 'account-menu'} onClick={() => setOpen(true)} title={`${person.name} · сменить пароль`}>
      <span className="account-menu-avatar" aria-hidden="true">{initials}</span>
      <span className="account-menu-name">{person.name}</span>
    </button>
    {open ? <PasswordDialog name={person.name} onClose={() => setOpen(false)} /> : null}
  </>
}

function PasswordDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const firstField = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    firstField.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await accountsApi.changeOwnPassword(current, next)
      setCurrent('')
      setNext('')
      setMessage({ ok: true, text: 'Пароль изменён.' })
    } catch (cause) {
      setMessage({ ok: false, text: cause instanceof Error ? cause.message : 'Не удалось изменить пароль.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="account-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" onSubmit={(event) => void submit(event)}>
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 id="account-dialog-title" className="flex items-center gap-2 font-semibold"><UserRound className="h-4 w-4" aria-hidden="true" />{name}</h2>
            <p className="text-sm text-slate-500">Смена своего пароля</p>
          </div>
          <button type="button" className="icon-button icon-button-compact" onClick={onClose} aria-label="Закрыть"><X className="h-4 w-4" /></button>
        </header>
        <label className="block text-sm">
          <span className="metric-label">Текущий пароль</span>
          <input ref={firstField} className="field-input" type="password" autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="metric-label">Новый пароль · не меньше {MIN_PASSWORD} символов</span>
          <input className="field-input" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={1024} value={next} onChange={(event) => setNext(event.target.value)} />
        </label>
        {message ? <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-sm text-emerald-800' : 'text-sm text-red-700'}>{message.text}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="secondary-button" onClick={onClose}>Закрыть</button>
          <button type="submit" className="primary-button" disabled={busy || !current || next.length < MIN_PASSWORD}><KeyRound className="h-4 w-4" aria-hidden="true" />{busy ? 'Сохраняем…' : 'Сменить пароль'}</button>
        </div>
      </form>
    </div>
  )
}
