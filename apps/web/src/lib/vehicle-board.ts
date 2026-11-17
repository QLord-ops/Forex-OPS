import type { Customer } from './api'
import { positionSource, terminMargin, vehiclePlace, vehicleStatus } from './fleet-status'
import { formatDurationMinutes, formatTime } from './format'
import { terminOf } from './tours'
import type { DashboardVehicle, Vehicle } from '../types/domain'

export type VehicleFilter = 'all' | 'no-gps' | 'no-line' | 'idle'
export type Tone = 'ok' | 'warn' | 'off' | 'late'

/** Fresh GPS, stale GPS, or none at all: the source of the position is always said. */
export function gpsState(row: DashboardVehicle | undefined, now = Date.now()): { kind: 'live' | 'stale' | 'none'; text: string } {
  if (!row) return { kind: 'none', text: 'нет данных' }
  const source = positionSource(row, now)
  if (source.kind === 'calculated') return { kind: 'none', text: 'нет GPS' }
  const age = source.short.replace(/^GPS\s*/, '')
  if (source.kind === 'stale') return { kind: 'stale', text: age ? `устарел · ${age}` : 'устарел' }
  return { kind: 'live', text: age ? `${age} назад` : 'свежий' }
}

/** What the truck does now, in two lines: «В пути · Bovenden → Salzgitter» and «ETA 06:40 · Termin 07:00, запас 20 мин». */
export function nowLines(row: DashboardVehicle | undefined, now = Date.now()): { title: string; sub: string; tone: Tone } {
  if (!row) return { title: 'Без тура', sub: '', tone: 'off' }
  const status = vehicleStatus(row, now)
  const place = vehiclePlace(row)
  // A delay is said in the second line; the first one stays what the truck does.
  const label = status.label === 'Опоздание' ? 'В пути' : status.label
  const title = status.tone === 'idle' ? 'Без тура' : `${label}${place ? ` · ${place}` : ''}`
  const termin = terminOf(row.tour)
  const margin = terminMargin(row)
  if (margin !== null && margin < 0) return { title, sub: `опоздание +${formatDurationMinutes(-margin)}${termin ? ` к ${termin.label}` : ''}`, tone: 'late' }
  if (status.tone === 'stop') {
    const dwell = row.dwellMinutes ?? null
    return { title, sub: dwell !== null ? `стоит ${formatDurationMinutes(dwell)}` : '', tone: 'ok' }
  }
  if (status.tone === 'idle') return { title, sub: '', tone: 'off' }
  const parts = [row.eta ? `ETA ${formatTime(row.eta)}` : null, termin ? `${termin.label}${margin !== null ? `, запас ${formatDurationMinutes(margin)}` : ''}` : null].filter(Boolean)
  return { title, sub: parts.join(' · '), tone: 'ok' }
}

export function lineLabelOf(vehicle: Vehicle, customers: Customer[]) {
  if (!vehicle.customerLineId) return null
  for (const customer of customers) {
    const line = customer.lines.find((item) => item.id === vehicle.customerLineId)
    if (line) return `${customer.name} · ${line.name}`
  }
  return vehicle.customerLine ? `${vehicle.customerLine.customer.name} · ${vehicle.customerLine.name}` : null
}

export function matchesVehicle(vehicle: Vehicle, row: DashboardVehicle | undefined, filter: VehicleFilter, query: string, now = Date.now()) {
  const text = query.trim().toLocaleLowerCase('de').replace(/\s+/g, '')
  if (text) {
    const haystack = [vehicle.vehicleNumber, vehicle.licensePlate, vehicle.servicePhone].filter(Boolean).join('|').toLocaleLowerCase('de').replace(/\s+/g, '')
    if (!haystack.includes(text)) return false
  }
  if (filter === 'no-gps') return gpsState(row, now).kind !== 'live'
  if (filter === 'no-line') return !vehicle.customerLineId
  if (filter === 'idle') return !row || vehicleStatus(row, now).tone === 'idle'
  return true
}

export interface VehicleGroup { id: string; name: string; meta: string; vehicles: Vehicle[] }

/**
 * Trucks by customer line in the customers' order, trucks without a line last. Each group says who runs the line;
 * without customers set up all trucks are one group.
 */
export function groupVehicles(vehicles: Vehicle[], customers: Customer[]): VehicleGroup[] {
  const byNumber = (a: Vehicle, b: Vehicle) => a.vehicleNumber.localeCompare(b.vehicleNumber, 'de', { numeric: true })
  if (!customers.length) return vehicles.length ? [{ id: 'all', name: 'Все машины', meta: count(vehicles.length), vehicles: [...vehicles].sort(byNumber) }] : []
  const groups: VehicleGroup[] = []
  for (const customer of customers) {
    for (const line of [...customer.lines].sort((a, b) => a.sortIndex - b.sortIndex)) {
      const own = vehicles.filter((vehicle) => vehicle.customerLineId === line.id).sort(byNumber)
      if (!own.length) continue
      const people = line.dispatchers.map((person) => person.name)
      groups.push({ id: line.id, name: `${customer.name} · ${line.name}`, meta: `${count(own.length)} · ${people.length ? `ведёт ${people.join(', ')}` : 'диспетчер не назначен'}`, vehicles: own })
    }
  }
  const known = new Set(groups.flatMap((group) => group.vehicles.map((vehicle) => vehicle.id)))
  const rest = vehicles.filter((vehicle) => !known.has(vehicle.id)).sort(byNumber)
  if (rest.length) groups.push({ id: 'none', name: 'Без линии', meta: `${count(rest.length)} · уведомления по ним получает только админ`, vehicles: rest })
  return groups
}

function count(value: number) {
  const tail = value % 10
  const word = value % 100 >= 11 && value % 100 <= 14 ? 'машин' : tail === 1 ? 'машина' : tail >= 2 && tail <= 4 ? 'машины' : 'машин'
  return `${value} ${word}`
}
