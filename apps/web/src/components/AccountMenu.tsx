import { Bot, CircleHelp, GraduationCap, KeyRound, Phone, UserRound, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { accountsApi } from '../lib/api'
import { usePopover } from '../hooks/usePopover'
import { currentDispatcher, currentDispatcherRole } from '../lib/auth'
import { ONBOARDING_EVENT } from '../lib/onboarding-steps'
import { AlertToggle } from './AlertToggle'
import { DispatcherLogout } from './AuthGate'
import { ThemeToggle } from './ThemeToggle'

const MIN_PASSWORD = 12

/** Who is signed in, with the theme, sound, the assistant, one's own password and logout. */
export function AccountMenu() {
  const person = currentDispatcher()
  const role = currentDispatcherRole()
  const name = person?.name ?? (role === 'admin' ? 'Администратор' : 'Диспетчер')
  const initials = person
    ? person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'
    : role === 'admin' ? 'АД' : 'ДС'
  const menu = usePopover()
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [phoneOpen, setPhoneOpen] = useState(false)
  return <div className="popover-anchor" ref={menu.ref}>
    <button type="button" className="account-menu" aria-expanded={menu.open} aria-haspopup="true" onClick={menu.toggle} title={name} aria-label={`${name}: меню`}>
      <span className="account-menu-avatar" aria-hidden="true">{initials}</span>
    </button>
    {menu.open ? <div className="popover-menu popover-menu-side account-menu-popover" aria-label="Меню диспетчера">
      <p className="account-menu-who"><strong>{name}</strong><span>{role === 'admin' ? 'администратор' : 'диспетчер'}{person ? '' : ' · общий вход'}</span></p>
      <ThemeToggle className="account-menu-item" />
      <AlertToggle className="account-menu-item" />
      <button type="button" className="account-menu-item" onClick={() => { menu.close(); window.dispatchEvent(new CustomEvent('ops:assistant-context', { detail: { open: true } })) }}><Bot className="h-5 w-5" aria-hidden="true" /><span>ИИ-диспетчер</span></button>
      <button type="button" className="account-menu-item" onClick={() => { menu.close(); window.dispatchEvent(new CustomEvent(ONBOARDING_EVENT, { detail: { start: 0 } })) }}><GraduationCap className="h-5 w-5" aria-hidden="true" /><span>Обучение</span></button>
      <Link to="/help" className="account-menu-item" onClick={menu.close}><CircleHelp className="h-5 w-5" aria-hidden="true" /><span>Справка</span></Link>
      {person ? <button type="button" className="account-menu-item" onClick={() => { menu.close(); setPhoneOpen(true) }}><Phone className="h-5 w-5" aria-hidden="true" /><span>Телефон для водителей</span></button> : null}
      {person ? <button type="button" className="account-menu-item" onClick={() => { menu.close(); setPasswordOpen(true) }}><KeyRound className="h-5 w-5" aria-hidden="true" /><span>Сменить пароль</span></button> : null}
      <DispatcherLogout className="account-menu-item account-menu-logout" />
    </div> : null}
    {passwordOpen ? <PasswordDialog name={name} onClose={() => setPasswordOpen(false)} /> : null}
    {phoneOpen ? <WorkPhoneDialog name={name} onClose={() => setPhoneOpen(false)} /> : null}
  </div>
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

/** The work number the drivers of one's trucks call from the driver app («Диспетчер» tab). */
function WorkPhoneDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const [phone, setPhone] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    accountsApi.ownWorkPhone().then((result) => { setPhone(result.workPhone ?? ''); setLoaded(true); window.setTimeout(() => field.current?.focus(), 0) })
      .catch(() => { setLoaded(true); setMessage({ ok: false, text: 'Телефон не загрузился. Повторите позже.' }) })
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const saved = await accountsApi.setOwnWorkPhone(phone)
      setPhone(saved.workPhone ?? '')
      setMessage({ ok: true, text: saved.workPhone ? 'Сохранено. Водители ваших машин звонят по этому номеру.' : 'Номер убран.' })
    } catch (cause) {
      setMessage({ ok: false, text: cause instanceof Error ? cause.message : 'Не удалось сохранить.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="account-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="phone-dialog-title" onSubmit={(event) => void submit(event)}>
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 id="phone-dialog-title" className="flex items-center gap-2 font-semibold"><Phone className="h-4 w-4" aria-hidden="true" />{name}</h2>
            <p className="text-sm text-slate-500">Телефон для водителей</p>
          </div>
          <button type="button" className="icon-button icon-button-compact" onClick={onClose} aria-label="Закрыть"><X className="h-4 w-4" /></button>
        </header>
        <label className="block text-sm">
          <span className="metric-label">Служебный номер диспетчерской</span>
          <input ref={field} className="field-input" type="tel" inputMode="tel" autoComplete="off" maxLength={40} placeholder="+49 551 …" disabled={!loaded} value={phone} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <p className="text-sm text-slate-500">Кнопка «Позвонить» в приложении водителя набирает этот номер у машин, которые вы ведёте (и у тех, где вы подменяете коллегу). Только служебный номер, не личный. Пустое поле — убрать номер.</p>
        {message ? <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-sm text-emerald-800' : 'text-sm text-red-700'}>{message.text}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="secondary-button" onClick={onClose}>Закрыть</button>
          <button type="submit" className="primary-button" disabled={busy || !loaded}><Phone className="h-4 w-4" aria-hidden="true" />{busy ? 'Сохраняем…' : 'Сохранить'}</button>
        </div>
      </form>
    </div>
  )
}
