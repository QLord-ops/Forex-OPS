import { CheckCircle2, Circle, Clock3, Dot } from 'lucide-react'

import { formatDateTime, metersToKm, stopTypeLabel } from '../lib/format'
import type { TimelineItem, Tour } from '../types/domain'
import { TourStatusBadge } from './StatusBadge'

const itemIcon = {
  DONE: CheckCircle2,
  CURRENT: Clock3,
  NEXT: Circle,
  QUEUED: Dot
}

export function TourTimeline({ tours, items }: { tours?: Tour[]; items?: TimelineItem[] }) {
  if (items?.length) {
    return (
      <div className="work-surface p-4">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Цепочка маршрутов</h2>
        <div className="space-y-3">
          {items.map((item) => (
            <TimelineRow key={item.id} item={item} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="work-surface min-w-0 p-4">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Цепочка маршрутов</h2>
      <div className="space-y-5">
        {tours?.map((tour) => (
          <div key={tour.id} className="border-l-2 border-slate-200 pl-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="font-semibold">Заказ {tour.orderNumber}</div>
              <TourStatusBadge status={tour.status} />
            </div>
            <div className="space-y-3">
              {tour.stops?.slice().sort((a, b) => a.sequence - b.sequence).map((stop) => (
                <div key={stop.id} className="grid grid-cols-[96px_1fr_auto] gap-3 text-sm">
                  <span className="tabular-nums text-slate-500">{formatDateTime(stop.appointmentAt)}</span>
                  <span>
                    <span className="font-medium">{stopTypeLabel(stop.type)}</span> · {stop.address}
                  </span>
                  <span className={stop.completedAt ? 'text-emerald-700' : 'text-slate-500'}>
                    {stop.completedAt ? 'ГОТОВО' : tour.status === 'QUEUED' ? 'В ОЧЕРЕДИ' : 'ДАЛЕЕ'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const Icon = itemIcon[item.status]
  const distance = item.leg ? metersToKm(item.leg.distanceMeters) : null

  return (
    <div className="grid grid-cols-[32px_1fr_auto] items-start gap-3 rounded-md border border-slate-100 px-3 py-3">
      <Icon className="mt-0.5 h-5 w-5 text-sky-600" aria-hidden="true" />
      <div>
        <div className="font-medium">{item.label}</div>
        <div className="mt-1 text-sm text-slate-500">
          {item.stop ? `${stopTypeLabel(item.stop.type)} · ${formatDateTime(item.stop.appointmentAt)}` : item.meta}
        </div>
      </div>
      <div className="text-sm font-medium text-slate-600">{distance}</div>
    </div>
  )
}
