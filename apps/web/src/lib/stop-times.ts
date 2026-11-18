import { etaText } from './route-progress'
import { formatTime } from './format'
import { sharedTerminOf, terminText } from './tours'
import type { Stop } from '../types/domain'

/** «Termin 18.11 14:00», «Termin 19.11 00:46–02:46», «общий Termin с точкой 2 · …»; null for a stop without any. */
export function stopTerminLabel(stop: Stop, stops: Stop[], short = false): string | null {
  const own = terminText({ appointmentAt: stop.appointmentAt, windowStartAt: stop.appointmentWindowStartAt, windowEndAt: stop.appointmentWindowEndAt })
  if (own) return `Termin ${short ? own.replace(/^\d{2}\.\d{2} /, '') : own}`
  const shared = sharedTerminOf(stops, stop)
  if (!shared) return null
  return short ? `Termin точки ${shared.lead.sequence}` : shared.label
}

/** In a narrow column: the time alone while it is within the next 18 hours, «19.11 12:53» for a later day. */
function shortTime(value: string, now: Date) {
  const date = new Date(value)
  if (Math.abs(date.getTime() - now.getTime()) < 18 * 3600_000) return formatTime(value)
  return `${new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(date)} ${formatTime(value)}`
}

/** The moment the stop must be reached by: its own Termin or the end of its window, or those of the stop it shares the Termin with. */
export function stopDeadline(stop: Stop, stops: Stop[]): string | null {
  const lead = sharedTerminOf(stops, stop)?.lead
  return stop.appointmentAt ?? stop.appointmentWindowEndAt ?? lead?.appointmentAt ?? lead?.appointmentWindowEndAt ?? null
}

export interface StopEtaView {
  /** «ETA 13:40», «ETA ≈ 19.11 04:10», «по плану ≈ 21:16», «на месте с 12:50»; «ETA нет» when nothing is known. */
  text: string
  /** The range behind «≈» in words, for the tooltip. */
  title?: string
  late: boolean
}

/**
 * The forecast of one open stop. A later stop gets «≈»: before it the truck loads or unloads for one to two hours at
 * each stop, so the time is the middle of the earliest and the latest arrival (owner, 18.11).
 */
export function stopEta(stop: Stop, stops: Stop[], now = new Date(), short = false): StopEtaView {
  const time = (value: string) => short ? shortTime(value, now) : etaText(value, now)
  if (stop.arrivedAt) return { text: `на месте с ${time(stop.arrivedAt)}`, late: false }
  if (!stop.predictedEta) return { text: 'ETA нет', late: false }
  const range = Boolean(stop.etaEarliest && stop.etaLatest && stop.etaEarliest !== stop.etaLatest)
  const deadline = stopDeadline(stop, stops)
  const late = Boolean(deadline && new Date(stop.predictedEta).getTime() > new Date(deadline).getTime())
  const text = `${stop.etaBasis === 'PLAN' ? 'по плану' : 'ETA'} ${range ? '≈ ' : ''}${time(stop.predictedEta)}`
  const why = stop.etaBasis === 'PLAN' ? 'Тур ещё не начат: считаем, что машина будет на первой точке к её Termin. ' : ''
  const title = range ? `${why}От ${etaText(stop.etaEarliest, now)} до ${formatTime(stop.etaLatest)}: стоянка на каждой точке до неё — от 1 до 2 часов, паузы водителя учтены.` : why || undefined
  return { text, title, late }
}
