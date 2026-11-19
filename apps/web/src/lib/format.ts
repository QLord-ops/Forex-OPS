import type { RiskColor, Stop, Tour } from '../types/domain'

export const calculatedPositionLabel = 'Расчётная позиция — без данных GPS'

/** Where the shown position comes from: fresh Webfleet, stale Webfleet, manual or calculated (never hidden). */
export function positionSourceText(position?: { positionSource?: 'WEBFLEET' | 'CALCULATED' | 'MANUAL'; telemetryStale?: boolean; telemetryAgeSeconds?: number | null } | null): string {
  if (position?.positionSource === 'WEBFLEET') {
    const age = typeof position.telemetryAgeSeconds === 'number' ? ` · ${Math.max(0, Math.round(position.telemetryAgeSeconds / 60))} мин назад` : ''
    return position.telemetryStale ? `Webfleet GPS устарел${age}` : `Webfleet GPS${age}`
  }
  if (position?.positionSource === 'MANUAL') return 'Позиция указана диспетчером вручную'
  return calculatedPositionLabel
}

/** Who recorded BELADEN/ENTLADEN: the dispatcher, Webfleet GPS by itself or the driver in the driver app. */
export function eventSourceLabel(source?: string | null): string | null {
  return source === 'DRIVER' ? 'водитель' : source === 'WEBFLEET_AUTO' ? 'GPS Webfleet' : source === 'DISPATCHER' ? 'диспетчер' : null
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '–'
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

export function formatAppointment(value?: string | null): string {
  return value ? formatDateTime(value) : 'Без срока'
}

export function formatTime(value?: string | null): string {
  if (!value) return '–'
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

export function formatKm(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–'
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
}

export function metersToKm(value?: number | null): string {
  if (value === null || value === undefined) return '–'
  return formatKm(value / 1000)
}

export function formatDelay(value?: number | null): string {
  if (value === null || value === undefined) return '–'
  if (value <= 0) return '0 мин'
  return `+${formatDurationMinutes(value)}`
}

export function formatDurationMinutes(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–'
  const totalMinutes = Math.max(0, Math.round(value))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days) parts.push(`${days} д`)
  if (hours) parts.push(`${hours} ч`)
  if (minutes || !parts.length) parts.push(`${minutes} мин`)
  return parts.join(' ')
}

export function formatElapsedMinutes(start?: string | null, end?: string | null, now = new Date()): string {
  if (!start) return '–'
  const startDate = new Date(start)
  const endDate = end ? new Date(end) : now
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return '–'
  return formatDurationMinutes((endDate.getTime() - startDate.getTime()) / 60_000)
}

export function statusLabel(status?: string | null): string {
  const labels: Record<string, string> = {
    DRAFT: 'Черновик',
    QUEUED: 'В очереди',
    ACTIVE: 'Активен',
    COMPLETED: 'Завершён',
    CANCELLED: 'Отменён',
    WAITING: 'Ожидает',
    WAITING_FOR_START: 'Ожидает начала',
    MOVING: 'В пути',
    ARRIVED: 'Прибыл',
    IDLE: 'Свободен',
    NO_ACTIVE_ROUTE: 'Нет активного маршрута',
    BREAK: 'Расчётная пауза',
    DAILY_REST: 'Расчётный ночной отдых',
    MANUAL_STOP: 'Остановлен вручную',
    PREDICTED_ARRIVAL: 'Ожидается прибытие'
  }

  return status ? labels[status] ?? 'Неизвестный статус' : '–'
}

export function operationEventLabel(type?: string | null): string {
  const labels: Record<string, string> = {
    CLOCK_CORRECTION: 'Корректировка часов',
    EXCEPTION_RESERVED: 'Исключение зарезервировано',
    EXCEPTION_RELEASED: 'Исключение освобождено',
    WEEKLY_REST_CONFIRMED: 'Еженедельный отдых подтверждён',
    ARRIVAL_CONFIRMED: 'Прибытие подтверждено',
    MANUAL_STOP: 'Движение остановлено',
    MOVEMENT_RESUMED: 'Движение продолжено',
    ROUTE_REPLANNED: 'Маршрут изменён',
    APPOINTMENT_ATTACHED: 'Термин прикреплён',
    REROUTE_ACCEPTED: 'Объезд принят',
    ROUTE_REBUILT_AUTO: 'Маршрут перестроен автоматически',
    TRAFFIC_REFRESH: 'Данные о трафике обновлены',
    TRUCK_PROFILE_UPDATED: 'Параметры грузовика обновлены'
  }

  return type ? labels[type] ?? 'Системное событие' : '–'
}

export function stopTypeLabel(type?: string): string {
  return type === 'LOAD' ? 'Загрузка' : 'Выгрузка'
}

export function riskLabel(risk: RiskColor): string {
  return {
    GREEN: 'Зелёный',
    YELLOW: 'Жёлтый',
    ORANGE: 'Оранжевый',
    RED: 'Красный',
    GREY: 'Серый'
  }[risk]
}

export function routeTitle(tour?: Tour | null): string {
  const stops = tour?.stops?.slice().sort((a, b) => a.sequence - b.sequence)
  if (!stops?.length) return 'Нет точек'
  const first = stops[0]
  const last = stops[stops.length - 1]
  return `${shortAddress(first)} → ${shortAddress(last)}`
}

/** The firm without its legal form: «Schnellecke Transportlogistik GmbH» → «Schnellecke», a long name → its first word. */
export function firmName(company?: string | null): string {
  const firm = (company ?? '').replace(/(^|\s)(GmbH|AG|SE|KG|KGaA|mbH|e\.K\.|Co\.?|&\s*Co\.?|Transportlogistik|Logistik)(?=\s|$|,)/gi, '$1').replace(/[&,]\s*$/, '').replace(/\s+/g, ' ').trim()
  return firm.length > 24 ? firm.split(' ')[0] : firm
}

/**
 * A stop as the dispatchers name it (owner, 18.11.2026): the firm and the town, «Musterwerk Jena», «MB Düsseldorf»;
 * the town alone when the firm already says it («Demo Lager Göttingen») or no firm is known.
 */
export function placeName(stop?: { company?: string | null; city?: string | null; address?: string | null } | null, keepPostcode = true): string {
  if (!stop) return ''
  const firm = firmName(stop.company)
  const raw = (stop.city ?? '').trim()
  const city = keepPostcode ? raw : raw.replace(/^\d{4,5}\s+/, '')
  const town = raw.replace(/^\d{4,5}\s+/, '')
  if (!firm) return city
  return town && !firm.toLowerCase().includes(town.toLowerCase()) ? `${firm} ${city}` : firm
}

export function shortAddress(stop?: Stop | null): string {
  if (!stop) return '–'
  return placeName(stop) || 'Город неизвестен'
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}
