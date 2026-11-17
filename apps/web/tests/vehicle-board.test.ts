import { describe, expect, it } from 'vitest'

import type { Customer } from '../src/lib/api'
import { gpsState, groupVehicles, lineLabelOf, matchesVehicle, nowLines } from '../src/lib/vehicle-board'
import type { DashboardVehicle, Vehicle } from '../src/types/domain'

const NOW = new Date('2026-11-03T12:00:00Z').getTime()
const vehicle = (number: string, extra: Partial<Vehicle> = {}): Vehicle => ({ id: `v${number}`, vehicleNumber: number, licensePlate: `GÖ-FX ${number}`, maxSpeedKmh: 85, ...extra })
const row = (number: string, partial: Partial<DashboardVehicle> = {}): DashboardVehicle =>
  ({ vehicle: vehicle(number), statusText: 'MOVING', risk: 'GREEN', ...partial }) as DashboardVehicle
const live = { source: 'WEBFLEET', stale: false, ageSeconds: 60 } as DashboardVehicle['telemetry']
const customers = [
  { id: 'c-sn', name: 'Schnellecke', lines: [{ id: 'nord', name: 'Nord', sortIndex: 1, dispatchers: [{ id: 'd1', name: 'Anna Keller', primary: true }] },
    { id: 'sued', name: 'Süd', sortIndex: 2, dispatchers: [] }] },
  { id: 'c-dsv', name: 'DSV', lines: [{ id: 'dsv', name: 'DSV', sortIndex: 1, dispatchers: [{ id: 'd2', name: 'Ben Hoffmann', primary: true }] }] }
] as unknown as Customer[]

describe('the trucks page', () => {
  it('says where the position comes from: fresh, stale or no GPS', () => {
    expect(gpsState(row('125', { telemetry: live }), NOW)).toEqual({ kind: 'live', text: '1 мин назад' })
    expect(gpsState(row('140', { telemetry: { source: 'WEBFLEET', stale: true, ageSeconds: 3 * 3600 } as DashboardVehicle['telemetry'] }), NOW)).toEqual({ kind: 'stale', text: 'устарел · 3 ч' })
    expect(gpsState(row('152', { telemetry: { source: 'CALCULATED', stale: false } as DashboardVehicle['telemetry'] }), NOW)).toEqual({ kind: 'none', text: 'нет GPS' })
    expect(gpsState(undefined, NOW).kind).toBe('none')
  })

  it('tells what the truck does now and a delay to its Termin', () => {
    expect(nowLines(row('140', { statusText: 'IDLE' }), NOW)).toEqual({ title: 'Без тура', sub: '', tone: 'off' })
    expect(nowLines(undefined, NOW).title).toBe('Без тура')
    const late = nowLines(row('9404', { delayMinutes: 18 }), NOW)
    expect(late.tone).toBe('late')
    expect(late.title).toBe('В пути')
    expect(late.sub).toMatch(/^опоздание \+18 мин/)
    expect(nowLines(row('125', { eta: '2026-11-03T13:40:00Z' }), NOW).sub).toMatch(/^ETA \d\d:\d\d$/)
  })

  it('groups the trucks by customer line with who runs it, trucks without a line last', () => {
    const trucks = [vehicle('131', { customerLineId: 'nord' }), vehicle('9404', { customerLineId: 'dsv' }), vehicle('125', { customerLineId: 'nord' }), vehicle('152'), vehicle('7', { customerLineId: 'sued' })]
    expect(groupVehicles(trucks, customers).map((group) => [group.name, group.meta, group.vehicles.map((item) => item.vehicleNumber)])).toEqual([
      ['Schnellecke · Nord', '2 машины · ведёт Anna Keller', ['125', '131']],
      ['Schnellecke · Süd', '1 машина · диспетчер не назначен', ['7']],
      ['DSV · DSV', '1 машина · ведёт Ben Hoffmann', ['9404']],
      ['Без линии', '1 машина · уведомления по ним получает только админ', ['152']]
    ])
    expect(groupVehicles(trucks, []).map((group) => group.vehicles.length)).toEqual([5])
    expect(groupVehicles([], customers)).toEqual([])
    expect(lineLabelOf(trucks[1]!, customers)).toBe('DSV · DSV')
    expect(lineLabelOf(trucks[3]!, customers)).toBeNull()
  })

  it('finds a truck by number, plate or phone and filters the ones that need a look', () => {
    const truck = vehicle('125', { servicePhone: '+49 151 2345', customerLineId: 'nord' })
    expect(matchesVehicle(truck, undefined, 'all', 'gö-fx125', NOW)).toBe(true)
    expect(matchesVehicle(truck, undefined, 'all', '1512345', NOW)).toBe(true)
    expect(matchesVehicle(truck, undefined, 'all', '999', NOW)).toBe(false)
    expect(matchesVehicle(truck, row('125', { telemetry: live }), 'no-gps', '', NOW)).toBe(false)
    expect(matchesVehicle(truck, row('125'), 'no-gps', '', NOW)).toBe(true)
    expect(matchesVehicle(truck, undefined, 'no-line', '', NOW)).toBe(false)
    expect(matchesVehicle(vehicle('152'), undefined, 'no-line', '', NOW)).toBe(true)
    expect(matchesVehicle(truck, row('125', { statusText: 'IDLE' }), 'idle', '', NOW)).toBe(true)
    expect(matchesVehicle(truck, row('125'), 'idle', '', NOW)).toBe(false)
  })
})
