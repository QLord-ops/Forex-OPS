import type { CurrentPosition, DashboardVehicle, Stop } from '../types/domain'
import { formatDateTime, formatDurationMinutes, formatKm, formatTime, shortAddress } from './format'

export type StopState = 'DONE' | 'AT_STOP' | 'HEADING' | 'NEXT' | 'UPCOMING'
export type RouteStage = 'ON_ROUTE' | 'ARRIVING' | 'AT_STOP' | 'WAITING' | 'FINISHED' | 'NONE'

export interface RouteProgress {
  stops: Array<{ stop: Stop; state: StopState }>
  stage: RouteStage
  /** 0-based index of the stop the truck is at or heading to; -1 when there is none. */
  currentIndex: number
  /** Share of the current leg already driven, 0..1. */
  legProgress: number
  /** Share of the whole tour, counting finished stops plus the current leg. */
  tourProgress: number
  /** One line for the collapsed drawer, e.g. «Этап 2 из 4 · В пути к Kassel · 35 км · ETA 13:00». */
  summary: string
  stageLabel: string
}

type RowLike = Pick<DashboardVehicle, 'remainingKm' | 'eta' | 'dwellMinutes' | 'statusText'>
type PositionLike = Pick<CurrentPosition, 'status' | 'progress'> | null | undefined

const isLoad = (stop: Stop) => stop.type === 'LOAD'

/** Where the truck is in its tour, derived only from confirmed events and the position forecast. */
export function routeProgress(input: Stop[] | undefined | null, row?: RowLike | null, position?: PositionLike, now = new Date()): RouteProgress {
  const ordered = (input ?? []).slice().sort((a, b) => a.sequence - b.sequence)
  if (!ordered.length) return { stops: [], stage: 'NONE', currentIndex: -1, legProgress: 0, tourProgress: 0, summary: 'Нет активного маршрута', stageLabel: 'Нет маршрута' }

  const currentIndex = ordered.findIndex((stop) => !stop.completedAt)
  if (currentIndex === -1) {
    return { stops: ordered.map((stop) => ({ stop, state: 'DONE' as const })), stage: 'FINISHED', currentIndex: -1, legProgress: 1, tourProgress: 1,
      summary: `Все ${ordered.length} точки пройдены`, stageLabel: 'Тур завершён' }
  }

  const current = ordered[currentIndex]
  const status = position?.status ?? (row?.statusText === 'MOVING' ? 'MOVING' : undefined)
  let stage: RouteStage
  if (current.arrivedAt) stage = 'AT_STOP'
  else if (status === 'ARRIVED' || (position?.progress ?? 0) >= 1) stage = 'ARRIVING'
  else if (status === 'MOVING') stage = 'ON_ROUTE'
  // A first stop without a driven leg means the tour has not started yet.
  else stage = currentIndex === 0 && !(position?.progress ?? 0) ? 'WAITING' : 'ON_ROUTE'

  const legProgress = stage === 'AT_STOP' || stage === 'ARRIVING' ? 1 : clamp(position?.progress ?? 0)
  const stops = ordered.map((stop, index) => ({
    stop,
    state: (index < currentIndex ? 'DONE' : index === currentIndex ? (stage === 'AT_STOP' ? 'AT_STOP' : 'HEADING') : index === currentIndex + 1 ? 'NEXT' : 'UPCOMING') as StopState
  }))
  // Each stop is one step: finished stops count fully, the current one by its leg progress.
  const tourProgress = clamp((currentIndex + (stage === 'AT_STOP' ? 0.5 : legProgress * 0.5)) / ordered.length)

  const place = shortAddress(current)
  const dwell = current.arrivedAt ? Math.max(0, Math.floor((now.getTime() - new Date(current.arrivedAt).getTime()) / 60_000)) : row?.dwellMinutes ?? null
  const stageLabel = stage === 'AT_STOP' ? `${isLoad(current) ? 'На загрузке' : 'На выгрузке'}, ${place}${dwell !== null ? ` · ${formatDurationMinutes(dwell)}` : ''}`
    : stage === 'ARRIVING' ? `Прибывает: ${place} · подтвердите прибытие`
      : stage === 'WAITING' ? `Ожидает начала · первая точка ${place}`
        : `В пути ${isLoad(current) ? 'на загрузку' : 'на выгрузку'}, ${place}${row?.remainingKm != null ? ` · ${formatKm(row.remainingKm)}` : ''}${row?.eta || current.predictedEta ? ` · ETA ${etaText(row?.eta ?? current.predictedEta, now)}` : ''}`

  return { stops, stage, currentIndex, legProgress, tourProgress, stageLabel, summary: `Этап ${currentIndex + 1} из ${ordered.length} · ${stageLabel}` }
}

function clamp(value: number) { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0 }

/** Time only for today, date and time otherwise, so an ETA tomorrow is not mistaken for today. */
export function etaText(value: string | null | undefined, now = new Date()) {
  if (!value) return '–'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '–'
  return date.toDateString() === now.toDateString() ? formatTime(value) : formatDateTime(value)
}
