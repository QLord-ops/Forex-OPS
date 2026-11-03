import { CalendarClock } from 'lucide-react'
import { useEffect, useState } from 'react'

import { api } from '../lib/api'
import { formatDateTime } from '../lib/format'
import type { PendingAppointment } from '../types/domain'

/** Slips that arrived before their Auftrag. Each one can be reviewed and attached, or dismissed. */
export function PendingAppointments({ version, onReview }: { version: number; onReview: (item: PendingAppointment) => void }) {
  const [items, setItems] = useState<PendingAppointment[]>([])
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let current = true
    api.pendingAppointments().then((result) => { if (current) { setItems(Array.isArray(result?.items) ? result.items : []); setError('') } }).catch(() => { if (current) setError('Список терминов не загрузился.') })
    return () => { current = false }
  }, [version, reload])

  async function dismiss(item: PendingAppointment) {
    if (!window.confirm(`Отклонить термин ${[item.company, item.city].filter(Boolean).join(', ') || ''}? Он останется в журнале.`)) return
    try { await api.dismissPendingAppointment(item.id); setReload((value) => value + 1) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось отклонить.') }
  }

  if (!items.length && !error) return null
  return <section className="pending-appointments" aria-label="Термины без тура">
    <h3><CalendarClock className="h-4 w-4" aria-hidden="true" />Термины без тура · {items.length}</h3>
    {error ? <p className="quick-order-error" role="alert">{error}</p> : null}
    <ul>
      {items.map((item) => {
        const found = item.match.status === 'MATCHED' ? item.match.candidates[0] : null
        return <li key={item.id}>
          <div className="min-w-0">
            <strong>{[item.company, item.city].filter(Boolean).join(', ') || 'Место не указано'}</strong>
            <span>{item.appointmentAt ? formatDateTime(item.appointmentAt) : `${formatDateTime(item.windowStartAt)}–${formatDateTime(item.windowEndAt)}`}{item.vehiclePlate ? ` · ${item.vehiclePlate}` : ''}</span>
            <span className={found ? 'pending-appointments-found' : ''}>{found ? `Найдена точка: LKW ${found.vehicleNumber}, ${found.orderNumber}` : item.match.status === 'AMBIGUOUS' ? 'Несколько подходящих точек' : 'Ждёт Auftrag'}</span>
          </div>
          <div className="pending-appointments-actions">
            <button type="button" className="primary-button compact-button" onClick={() => onReview(item)}>Проверить</button>
            <button type="button" className="secondary-button compact-button" onClick={() => void dismiss(item)}>Отклонить</button>
          </div>
        </li>
      })}
    </ul>
  </section>
}
