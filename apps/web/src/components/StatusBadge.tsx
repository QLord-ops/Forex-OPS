import type { RiskColor, TourStatus } from '../types/domain'
import { classNames, riskLabel, statusLabel } from '../lib/format'

const riskClasses: Record<RiskColor, string> = {
  GREEN: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  YELLOW: 'border-yellow-200 bg-yellow-50 text-yellow-900',
  ORANGE: 'border-orange-200 bg-orange-50 text-orange-900',
  RED: 'border-red-200 bg-red-50 text-red-800',
  GREY: 'border-slate-200 bg-slate-100 text-slate-700'
}

const tourClasses: Record<TourStatus, string> = {
  DRAFT: 'border-slate-200 bg-slate-50 text-slate-700',
  QUEUED: 'border-sky-200 bg-sky-50 text-sky-800',
  ACTIVE: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  COMPLETED: 'border-slate-200 bg-white text-slate-600',
  CANCELLED: 'border-red-200 bg-red-50 text-red-800'
}

export function RiskBadge({ risk }: { risk: RiskColor }) {
  return <span className={classNames('badge', riskClasses[risk])}>{riskLabel(risk)}</span>
}

export function TourStatusBadge({ status }: { status: TourStatus }) {
  return <span className={classNames('badge', tourClasses[status])}>{statusLabel(status)}</span>
}
