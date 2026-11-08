import { CalendarCheck, CalendarDays, LogOut, MapPinCheck, MessageSquareText, Moon, Route, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import { departureOf, useNotifications } from '../context/notifications'
import { alertPermission, answerRequired, bannerDismissed, dismissBanner, needsAttention, nightItems, requestAlertPermission, type AlertNotification, type AlertPermission } from '../lib/alerts'
import { pendingToDocument } from '../lib/appointments'
import { formatTime } from '../lib/format'
import { terminText } from '../lib/tours'
import type { Stop } from '../types/domain'
import { AppointmentReview } from './AppointmentReview'

type Tone = 'late' | 'termin' | 'arrival' | 'ok' | 'info'

/** One open question for the dispatcher, with its own buttons. Used in «Требует решения», the bell and the toast. */
export function DecisionCard({ item, stop, onSelect, openLink = false, nested = false }: { item: AlertNotification; stop?: Stop | null; onSelect?: (vehicleId: string) => void; openLink?: boolean; nested?: boolean }) {
  const state = useNotifications()
  // Earlier notifications of the same truck fold under its card; «Понятно» closes them too, decisions that wait for an answer stay.
  const stack = nested ? [] : state.stackOf(item)
  const waiting = stack.filter(answerRequired).length
  const closes = 1 + stack.length - waiting
  const navigate = useNavigate()
  const busy = state.busyId === item.id
  const error = state.errors[item.id]
  const vehicle = /LKW\s+(\S+?)[\s,]/.exec(item.message)?.[1]
  const place = stop ? stop.city || stop.address : null
  const departure = item.type === 'STOP_DEPARTED' ? departureOf(item.payloadJson) : null
  const pending = item.type === 'APPOINTMENT_MATCH' ? state.pendingOf(item) : null
  const candidate = pending?.match.status === 'MATCHED' ? pending.match.candidates[0] : null

  let tone: Tone = 'info'
  let Icon = MessageSquareText
  let title = item.message
  let detail: string | null = null
  let actions: Array<{ label: string; primary?: boolean; run: () => void }> = [{ label: 'Прочитано', run: () => void state.resolve(item, 'ack') }]
  if (departure) {
    const load = departure.stopType === 'LOAD'
    tone = 'late'; Icon = LogOut
    title = `${vehicle ? `LKW ${vehicle} уехала` : 'Машина уехала'} ${load ? 'с загрузки' : 'с выгрузки'} без ${load ? 'BELADEN' : 'ENTLADEN'}`
    detail = place ? `${place}, выезд ${departure.time} · GPS Webfleet` : item.message
    actions = [
      { label: `${load ? 'BELADEN' : 'ENTLADEN'} ${departure.time}`, primary: true, run: () => void state.answerDeparture(item, 'done') },
      { label: load ? 'Не загружена' : 'Не выгружена', run: () => void state.answerDeparture(item, 'keep') },
      { label: 'Ошибка прибытия', run: () => void state.answerDeparture(item, 'revert') }
    ]
  } else if (item.type === 'AUTO_ARRIVAL') {
    tone = 'arrival'; Icon = MapPinCheck
    title = `${vehicle ? `LKW ${vehicle} прибыла` : 'Машина прибыла'} ${stop?.type === 'UNLOAD' ? 'на выгрузку' : stop?.type === 'LOAD' ? 'на загрузку' : 'на точку'}`
    detail = place ? `${place}${stop?.arrivedAt ? `, ${formatTime(stop.arrivedAt)}` : ''} · GPS Webfleet, автоматически. BELADEN/ENTLADEN подтверждаете вы` : item.message
    actions = [{ label: 'Понятно', primary: true, run: () => void state.resolve(item, 'ack') }]
    if (item.stopId) actions.push({ label: 'Отменить прибытие', run: () => void state.resolve(item, 'revert') })
  } else if (item.type === 'ROUTE_DEVIATION') {
    tone = 'late'; Icon = Route
    title = `${vehicle ? `LKW ${vehicle}` : 'Машина'} отклонилась от маршрута`
    detail = item.message
    actions = [
      { label: 'Варианты маршрута', primary: true, run: () => { state.hide(item.id); void state.resolve(item, 'ack'); navigate(`/?vehicleId=${encodeURIComponent(item.vehicleId)}&routes=1`) } },
      { label: 'Понятно', run: () => void state.resolve(item, 'ack') }
    ]
  } else if (item.type === 'TERMIN_MET') {
    const onTime = /вовремя/.test(item.message)
    tone = onTime ? 'ok' : 'late'; Icon = CalendarCheck
    title = onTime ? `${vehicle ? `LKW ${vehicle}` : 'Машина'} прибыла вовремя · Termin выполнен` : `${vehicle ? `LKW ${vehicle}` : 'Машина'} прибыла с опозданием`
    detail = item.message
    actions = [{ label: 'Понятно', primary: true, run: () => void state.resolve(item, 'ack') }]
  } else if (item.type === 'DAILY_REST_AT_STOP') {
    tone = 'info'; Icon = Moon
    const unload = (stop?.type ?? restStopType(item.payloadJson)) === 'UNLOAD'
    title = `${vehicle ? `LKW ${vehicle}` : 'Машина'} на суточном отдыхе ${unload ? 'на выгрузке' : 'на загрузке'}`
    detail = item.message
    actions = [{ label: 'Понятно', primary: true, run: () => void state.resolve(item, 'ack') }]
  } else if (item.type === 'PREVIOUS_TOUR_OPEN') {
    tone = 'late'; Icon = TriangleAlert
    title = `${vehicle ? `LKW ${vehicle}` : 'Машина'} уже на следующем туре, прошлый не закрыт`
    detail = item.message
    actions = [{ label: 'Понятно', run: () => void state.resolve(item, 'ack') }]
  } else if (item.type === 'APPOINTMENT_MATCH') {
    tone = 'termin'; Icon = CalendarDays
    title = 'Termin на проверку'
    detail = candidate && pending
      ? [`LKW ${candidate.vehicleNumber}`, `Auftrag ${candidate.orderNumber}`, [candidate.city ?? pending.city, terminText(pending)].filter(Boolean).join(' ')].join(' · ')
      : item.message
    actions = [
      { label: 'Принять', primary: true, run: () => void state.acceptTermin(item) },
      { label: 'Исправить', run: () => void state.reviewTermin(item) }
    ]
  }

  if (closes > 1) actions = actions.map((action) => action.label === 'Понятно' || action.label === 'Прочитано' ? { ...action, label: `${action.label} · все ${closes}` } : action)

  const headingId = `decision-${item.id}`
  return <article className={`decision-card decision-card-${item.resolved ? 'info' : tone}${nested ? ' decision-card-nested' : ''}`} aria-labelledby={headingId}>
    <Icon className="decision-card-icon" aria-hidden="true" />
    <div className="min-w-0">
      {onSelect ? <button type="button" id={headingId} className="decision-card-title" onClick={() => onSelect(item.vehicleId)}>{title}</button> : <h3 id={headingId} className="decision-card-title">{title}</h3>}
      {item.resolved ? <p className="decision-card-stale">Уже не актуально{item.resolvedReason ? `: ${item.resolvedReason}` : ''}</p> : null}
      {detail ? <p className="decision-card-detail">{detail}</p> : null}
      {error ? <p role="alert" className="decision-card-error">{error}</p> : null}
      <div className="decision-card-actions">
        {actions.map((action) => <button key={action.label} type="button" className={action.primary ? 'decision-button decision-button-primary' : 'decision-button'} disabled={busy} onClick={action.run}>{action.label}</button>)}
        {openLink ? <Link className="decision-button" to={`/vehicles/${item.vehicleId}`} onClick={() => state.hide(item.id)}>Открыть грузовик</Link> : null}
      </div>
      {stack.length ? <details className="decision-stack">
        <summary>Ещё {stack.length} по этой машине{waiting ? <span className="decision-stack-waiting"> · ждут ответа: {waiting}</span> : null}</summary>
        {stack.length - waiting > 1 ? <button type="button" className="decision-button decision-stack-close" disabled={state.busyId === 'all'} onClick={() => void state.acknowledgeAll(stack.filter((older) => !answerRequired(older)))}>Прочитать эти {stack.length - waiting}</button> : null}
        <div className="decision-stack-list">{stack.map((older) => <DecisionCard key={older.id} item={older} nested />)}</div>
      </details> : null}
    </div>
  </article>
}

/**
 * «Требует решения» in priority order: decisions, then risks; information and what no longer applies
 * waits folded in «Для сведения» with one «Прочитать все».
 */
export function DecisionGroups({ items, stopOf, onSelect, openLink = false }: { items: AlertNotification[]; stopOf?: (item: AlertNotification) => Stop | null | undefined; onSelect?: (vehicleId: string) => void; openLink?: boolean }) {
  const state = useNotifications()
  const actions = items.filter((item) => needsAttention(item) && item.priority !== 'RISK')
  const risks = items.filter((item) => needsAttention(item) && item.priority === 'RISK')
  const info = items.filter((item) => !needsAttention(item))
  const night = nightItems(items, state.workHours)
  const nightDecisions = night.filter((item) => needsAttention(item) && item.priority !== 'RISK').length
  const card = (item: AlertNotification) => <DecisionCard key={item.id} item={item} stop={stopOf?.(item)} onSelect={onSelect} openLink={openLink} />
  const readAll = () => {
    if (window.confirm(`Отметить прочитанными ${info.length} уведомл. «Для сведения»? Требующие решения останутся.`)) void state.acknowledgeAll(info)
  }
  return <div className="decision-groups">
    {night.length ? <p className="decision-night" role="status">За ночь: {night.length}{nightDecisions ? ` · требуют решения: ${nightDecisions}` : ''}</p> : null}
    {actions.length ? <div className="decision-group" role="group" aria-label="Нужно решение">
      <h3 className="decision-group-title decision-group-action">Нужно решение<span>{actions.length}</span></h3>
      <div className="decision-list">{actions.map(card)}</div>
    </div> : null}
    {risks.length ? <div className="decision-group" role="group" aria-label="Важно">
      <h3 className="decision-group-title decision-group-risk">Важно<span>{risks.length}</span></h3>
      <div className="decision-list">{risks.map(card)}</div>
    </div> : null}
    {info.length ? <details className="decision-info">
      <summary className="decision-group-title"><span className="decision-info-name">Для сведения</span><span>{info.length}</span></summary>
      <div className="decision-info-actions">
        <button type="button" className="decision-button" disabled={state.busyId === 'all'} onClick={readAll}>Прочитать все</button>
        {state.errors.all ? <p role="alert" className="decision-card-error">{state.errors.all}</p> : null}
      </div>
      <div className="decision-list">{info.map(card)}</div>
    </details> : null}
  </div>
}

function restStopType(payloadJson?: string | null) {
  try { return (JSON.parse(payloadJson ?? '{}') as { stopType?: string }).stopType ?? null } catch { return null }
}

/** Off the dashboard the oldest open question shows as a toast; on the dashboard it lives in «Требует решения». */
export function OperationsNotifications() {
  const state = useNotifications()
  const location = useLocation()
  const [permission, setPermission] = useState<AlertPermission>(alertPermission)
  const [banner, setBanner] = useState(() => !bannerDismissed())
  const onDashboard = location.pathname === '/'

  if (state.termin) return <div className="appointment-review-overlay" role="dialog" aria-modal="true" aria-label="Проверка термина">
    <AppointmentReview document={pendingToDocument(state.termin)} fingerprint={state.termin.fingerprint} match={state.termin.match} pendingId={state.termin.id} fileName="Ожидающий Termin"
      onApplied={() => void state.closeTermin(true)} onSaved={() => void state.closeTermin(false)} onSkip={() => void state.closeTermin(false)} />
  </div>
  const current = onDashboard ? undefined : state.open.find(needsAttention)
  const askPermission = permission === 'default' && banner
  if (!current && !askPermission) return null
  return <aside role="dialog" aria-labelledby={current ? `decision-${current.id}` : 'operations-permission-heading'} className="operations-toast">
    {askPermission ? <div className={current ? 'operations-toast-permission operations-toast-permission-split' : 'operations-toast-permission'}>
      <h2 id="operations-permission-heading" className="font-semibold">Включите уведомления, чтобы не пропустить прибытие</h2>
      <p className="my-2 text-sm text-slate-600">Со звуком и окном Windows поверх других программ, пока вкладка OPS открыта.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="primary-button" onClick={() => void requestAlertPermission().then(setPermission)}>Включить</button>
        <button type="button" className="secondary-button" onClick={() => { dismissBanner(); setBanner(false) }}>Не сейчас</button>
      </div>
    </div> : null}
    {current ? <DecisionCard item={current} openLink /> : null}
  </aside>
}
