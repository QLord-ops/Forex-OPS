import { Check, Copy, Mail, MessageSquareText, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

import { useNotifications } from '../context/notifications'
import { api, customersApi } from '../lib/api'
import { terminMargin } from '../lib/fleet-status'
import { draftNotice, noticeKind, type NoticeKind } from '../lib/customer-notice'
import { formatTime } from '../lib/format'
import { currentStopOf } from '../lib/tours'
import type { DashboardVehicle } from '../types/domain'
import './customer-notice.css'

const WIDTH = 360

export function CustomerNoticeButton({ row, className = 'secondary-button', compact = false }: { row: DashboardVehicle; className?: string; compact?: boolean }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  if (!row.tour || !row.customer) return null
  return <>
    <button ref={button} type="button" className={className} aria-expanded={Boolean(anchor)} onClick={(event) => setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect())} title="Короткое письмо заказчику: опоздание к Termin или ожидание на точке">
      <MessageSquareText className="h-4 w-4" aria-hidden="true" />{compact ? 'Заказчику' : 'Сообщить заказчику'}
    </button>
    {anchor ? createPortal(<CustomerNoticePopup row={row} anchor={anchor} onClose={() => { setAnchor(null); button.current?.focus() }} />, document.body) : null}
  </>
}

/** Beside the button, opening upwards when there is room above it (the bottom panel), downwards otherwise. */
function placement(anchor: DOMRect): CSSProperties {
  const left = Math.max(8, Math.min(anchor.right - WIDTH, window.innerWidth - WIDTH - 8))
  return anchor.top > 320 ? { left, bottom: window.innerHeight - anchor.top + 8, width: WIDTH } : { left, top: anchor.bottom + 8, width: WIDTH }
}

/**
 * «Сообщить заказчику» as a small window, written the way the dispatchers write (owner, 18.11.2026): the truck number as
 * the subject and one German line; Outlook adds the signature. OPS records that the customer was told.
 */
function CustomerNoticePopup({ row, anchor, onClose }: { row: DashboardVehicle; anchor: DOMRect; onClose: () => void }) {
  const { open } = useNotifications()
  const jam = open.some((item) => item.vehicleId === row.vehicle.id && !item.resolved && item.type === 'TRAFFIC_DELAY')
  const [kind, setKind] = useState<NoticeKind>(() => noticeKind(row) ?? 'LATE')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState(() => draftNotice(row, kind, jam).subject)
  const [body, setBody] = useState(() => draftNotice(row, kind, jam).body)
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'done' | 'error'; text?: string }>({ kind: 'idle' })
  const [contacts, setContacts] = useState<'loading' | 'none' | 'ok'>('loading')
  const box = useRef<HTMLElement | null>(null)
  const text = useRef<HTMLTextAreaElement | null>(null)
  const stop = row.tour ? currentStopOf(row.tour) : null
  const [style, setStyle] = useState<CSSProperties>(() => placement(anchor))
  useLayoutEffect(() => { setStyle(placement(anchor)) }, [anchor])

  useEffect(() => {
    let alive = true
    const id = row.customer?.id
    if (!id) { setContacts('none'); return }
    customersApi.get(id).then((customer) => {
      if (!alive) return
      const emails = customer.profile.notify?.emails ?? []
      setTo(emails.join(', '))
      setContacts(emails.length ? 'ok' : 'none')
    }).catch(() => { if (alive) setContacts('none') })
    return () => { alive = false }
  }, [row.customer?.id])
  useEffect(() => { text.current?.focus(); text.current?.setSelectionRange(text.current.value.length, text.current.value.length) }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const onPointer = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) onClose() }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onPointer) }
  }, [onClose])

  function pick(next: NoticeKind) {
    setKind(next)
    const draft = draftNotice(row, next, jam)
    setBody(draft.body)
    setSubject(draft.subject)
  }
  const recipients = to.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean)
  async function record(channel: 'EMAIL' | 'COPY') {
    if (!row.tour || !stop) return
    setState({ kind: 'busy' })
    try {
      const margin = terminMargin(row)
      const notice = await api.recordCustomerNotice(row.vehicle.id, { tourId: row.tour.id, stopId: stop.id, channel, etaAt: row.eta ?? null, delayMinutes: margin !== null && margin < 0 ? -margin : null, recipients: recipients.length })
      setState({ kind: 'done', text: `Отмечено: заказчик уведомлён ${formatTime(notice.at)}` })
      window.dispatchEvent(new CustomEvent('ops:data-changed'))
    } catch (cause) {
      setState({ kind: 'error', text: cause instanceof Error ? cause.message : 'Отметка не сохранена.' })
    }
  }
  function openMail() {
    window.location.href = `mailto:${recipients.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    void record('EMAIL')
  }
  async function copy() {
    try { await navigator.clipboard.writeText(body) } catch {
      setState({ kind: 'error', text: 'Браузер не дал скопировать: выделите текст и скопируйте сами.' })
      return
    }
    void record('COPY')
  }

  return <section ref={box} className="customer-notice-pop" style={style} role="dialog" aria-labelledby="customer-notice-title">
    <header className="customer-notice-head">
      <h2 id="customer-notice-title">Сообщить заказчику · LKW {row.vehicle.vehicleNumber}</h2>
      <button type="button" className="icon-button icon-button-compact" onClick={onClose} aria-label="Закрыть"><X className="h-4 w-4" /></button>
    </header>
    <div className="customer-notice-kinds" role="group" aria-label="О чём письмо">
      <button type="button" aria-pressed={kind === 'LATE'} onClick={() => pick('LATE')}>Опоздание</button>
      <button type="button" aria-pressed={kind === 'WAITING'} onClick={() => pick('WAITING')}>Ждёт на точке</button>
    </div>
    <label className="customer-notice-field"><span>Кому</span><input type="text" inputMode="email" value={to} onChange={(event) => setTo(event.target.value)} placeholder="dispo@kunde.de" /></label>
    {contacts === 'none' ? <p className="customer-notice-hint">Адресов в профиле заказчика нет: впишите здесь или в «Заказчики» → «Статус».</p> : null}
    <label className="customer-notice-field"><span>Тема</span><input value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
    <label className="customer-notice-text"><span className="sr-only">Текст</span><textarea ref={text} rows={3} value={body} onChange={(event) => setBody(event.target.value)} /></label>
    <p className="customer-notice-hint">Подпись добавит ваша почта.</p>
    {state.text ? <p role={state.kind === 'error' ? 'alert' : 'status'} className={state.kind === 'error' ? 'customer-notice-error' : 'customer-notice-done'}>{state.kind === 'done' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}{state.text}</p> : null}
    <div className="customer-notice-actions">
      <button type="button" className="secondary-button compact-button" onClick={() => void copy()} disabled={state.kind === 'busy'}><Copy className="h-4 w-4" aria-hidden="true" />Копировать</button>
      <button type="button" className="primary-button compact-button" onClick={openMail} disabled={state.kind === 'busy' || !recipients.length}><Mail className="h-4 w-4" aria-hidden="true" />Открыть в почте</button>
    </div>
  </section>
}
