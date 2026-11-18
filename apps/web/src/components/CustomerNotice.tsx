import { Copy, Mail, MessageSquareText, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useNotifications } from '../context/notifications'
import { api, customersApi } from '../lib/api'
import { currentDispatcher } from '../lib/auth'
import { terminMargin } from '../lib/fleet-status'
import { draftNotice } from '../lib/customer-notice'
import { formatTime } from '../lib/format'
import { currentStopOf } from '../lib/tours'
import type { AlertNotification } from '../lib/alerts'
import type { DashboardVehicle } from '../types/domain'
import './customer-notice.css'

export function CustomerNoticeButton({ row, className = 'secondary-button', compact = false }: { row: DashboardVehicle; className?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!row.tour || !row.customer) return null
  return <>
    <button type="button" className={className} onClick={() => setOpen(true)} title="Письмо заказчику об опоздании к Termin">
      <MessageSquareText className="h-4 w-4" aria-hidden="true" />{compact ? 'Заказчику' : 'Сообщить заказчику'}
    </button>
    {open ? <CustomerNoticeDialog row={row} onClose={() => setOpen(false)} /> : null}
  </>
}

/** The reason a dispatcher would give: the jam or the detour that made the truck late, if OPS knows it. */
function reasonOf(items: AlertNotification[], vehicleId: string) {
  const own = items.filter((item) => item.vehicleId === vehicleId && !item.resolved)
  if (own.some((item) => item.type === 'TRAFFIC_DELAY')) return 'Stau auf der Strecke'
  if (own.some((item) => item.type === 'ROUTE_DEVIATION')) return 'Umleitung auf der Strecke'
  return ''
}

function CustomerNoticeDialog({ row, onClose }: { row: DashboardVehicle; onClose: () => void }) {
  const { open } = useNotifications()
  const signature = currentDispatcher()?.name ?? 'Disposition'
  const initial = useMemo(() => draftNotice(row, reasonOf(open, row.vehicle.id), signature), [open, row, signature])
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState(initial.subject)
  const [body, setBody] = useState(initial.body)
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'done' | 'error'; text?: string }>({ kind: 'idle' })
  const [contacts, setContacts] = useState<'loading' | 'none' | 'ok'>('loading')
  const first = useRef<HTMLInputElement | null>(null)
  const stop = row.tour ? currentStopOf(row.tour) : null

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
  useEffect(() => { first.current?.focus() }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const recipients = to.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean)
  async function record(channel: 'EMAIL' | 'COPY') {
    if (!row.tour || !stop) return
    setState({ kind: 'busy' })
    try {
      const margin = terminMargin(row)
      const notice = await api.recordCustomerNotice(row.vehicle.id, { tourId: row.tour.id, stopId: stop.id, channel, etaAt: row.eta ?? null, delayMinutes: margin !== null && margin < 0 ? -margin : null, recipients: recipients.length })
      setState({ kind: 'done', text: `Отмечено: заказчик уведомлён ${formatTime(notice.at)}.` })
      window.dispatchEvent(new CustomEvent('ops:data-changed'))
    } catch (cause) {
      setState({ kind: 'error', text: cause instanceof Error ? cause.message : 'Отметка не сохранена.' })
    }
  }
  function openMail() {
    const href = `mailto:${recipients.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    window.location.href = href
    void record('EMAIL')
  }
  async function copy() {
    try { await navigator.clipboard.writeText(`${subject}\n\n${body}`) } catch {
      setState({ kind: 'error', text: 'Браузер не дал скопировать: выделите текст в поле и скопируйте сами.' })
      return
    }
    void record('COPY')
  }

  return <div className="account-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="account-dialog customer-notice-dialog" role="dialog" aria-modal="true" aria-labelledby="customer-notice-title">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="customer-notice-title" className="font-semibold">Сообщить заказчику · LKW {row.vehicle.vehicleNumber}</h2>
          <p className="text-sm text-slate-500">{row.customer?.name}{stop ? ` · ${stop.city || stop.address}` : ''}. Письмо откроется в вашей почте: проверьте и отправьте.</p>
        </div>
        <button type="button" className="icon-button icon-button-compact" onClick={onClose} aria-label="Закрыть"><X className="h-4 w-4" /></button>
      </header>
      <label className="block text-sm">
        <span className="metric-label">Кому</span>
        <input ref={first} className="field-input" type="text" inputMode="email" value={to} onChange={(event) => setTo(event.target.value)} placeholder="dispo@kunde.de" />
        {contacts === 'none' ? <span className="customer-notice-hint">В профиле заказчика нет адресов. Впишите адрес здесь или добавьте их в «Заказчики» → «Статус» → «Контакты для уведомлений».</span> : null}
      </label>
      <label className="block text-sm"><span className="metric-label">Тема</span><input className="field-input" value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
      <label className="block text-sm"><span className="metric-label">Текст (немецкий, можно править)</span><textarea className="field-input customer-notice-body" rows={12} value={body} onChange={(event) => setBody(event.target.value)} /></label>
      {state.text ? <p role={state.kind === 'error' ? 'alert' : 'status'} className={state.kind === 'error' ? 'text-sm text-red-700' : 'text-sm text-emerald-800'}>{state.text}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="secondary-button" onClick={onClose}>{state.kind === 'done' ? 'Готово' : 'Отмена'}</button>
        <button type="button" className="secondary-button" onClick={() => void copy()} disabled={state.kind === 'busy'}><Copy className="h-4 w-4" aria-hidden="true" />Скопировать текст</button>
        <button type="button" className="primary-button" onClick={openMail} disabled={state.kind === 'busy' || !recipients.length}><Mail className="h-4 w-4" aria-hidden="true" />Открыть в почте</button>
      </div>
    </section>
  </div>
}
