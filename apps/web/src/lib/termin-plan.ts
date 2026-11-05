import type { TerminCandidate, TerminPlan, TerminSegment, TerminSegmentType, VehicleBrief } from '../types/assistant'
import { berlinClock, formatDurationMs } from './telemetry-format'

export function isTerminPlan(value: unknown): value is TerminPlan {
  return Boolean(value) && typeof value === 'object' && (value as { kind?: unknown }).kind === 'TERMIN' && Array.isArray((value as { timeline?: unknown }).timeline)
}
export function isVehicleBrief(value: unknown): value is VehicleBrief {
  return Boolean(value) && typeof value === 'object' && (value as { kind?: unknown }).kind === 'VEHICLE_BRIEF' && typeof (value as { driver?: unknown }).driver === 'object'
}

const SEGMENT_LABEL: Record<TerminSegmentType, string> = { DRIVE: 'Движение', BREAK: 'Перерыв', DAILY_REST: 'Суточный отдых', SERVICE: 'Стоянка на точке', WAIT: 'Ожидание Termin' }
export function segmentLabel(type: TerminSegmentType): string { return SEGMENT_LABEL[type] ?? type }

export type TimelineRow = { key: string; time: string; until: string; type: TerminSegmentType; text: string; pause: boolean }
/** One line per stretch of the plan: "09:00 → 09:45 · Перерыв · 45 мин", in Berlin time. */
export function timelineRows(plan: Pick<TerminPlan, 'timeline'>, now = new Date()): TimelineRow[] {
  return plan.timeline.map((segment: TerminSegment, index) => ({
    key: `${segment.startAt}-${index}`,
    time: berlinClock(segment.startAt, now), until: berlinClock(segment.endAt, now), type: segment.type,
    text: `${segment.label || segmentLabel(segment.type)} · ${formatDurationMs(segment.durationSeconds * 1000)}`,
    pause: segment.type === 'BREAK' || segment.type === 'DAILY_REST'
  }))
}

export function verdictText(verdict: TerminCandidate['verdict'] | 'NONE' | 'UNKNOWN'): string {
  return ({ OK: 'успевает', RISK: 'риск', LATE: 'опоздание', NONE: 'без Termin', UNKNOWN: 'не определено' } as Record<string, string>)[verdict] ?? verdict
}
export function candidateText(candidate: TerminCandidate): string {
  return `${candidate.atLocal} · ${candidate.note || verdictText(candidate.verdict)}`
}
export function sourceText(plan: Pick<TerminPlan, 'source' | 'preliminary'>): string {
  return plan.source === 'WEBFLEET' ? `по тахографу Webfleet${plan.preliminary ? ' · предварительно' : ''}` : 'по расчётным часам машины · предварительно'
}
export function resultTitle(value: unknown): string {
  if (isTerminPlan(value)) return `Termin · LKW ${value.vehicleNumber} · ${sourceText(value)}`
  if (isVehicleBrief(value)) return `Сводка · LKW ${value.vehicleNumber}`
  return 'Черновой расчёт · рабочий маршрут не изменён'
}
export function positionText(position: VehicleBrief['position']): string {
  const source = position.source === 'WEBFLEET' ? (position.stale ? 'Webfleet, устарело' : 'Webfleet') : position.source === 'MANUAL' ? 'указана диспетчером' : position.source === 'CALCULATED' ? 'расчёт' : 'нет данных'
  const age = position.ageMinutes !== null && position.source === 'WEBFLEET' ? `, ${position.ageMinutes} мин назад` : ''
  return `${position.address ? `${position.address} · ` : ''}${source}${age}${position.remainingKm !== null ? ` · осталось ≈ ${position.remainingKm} км` : ''}`
}
