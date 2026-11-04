import { describe, expect, it } from 'vitest'

import { compareVehicles, matchesFleetFilter, needsDecision, positionSource, terminMargin, vehiclePlace, vehicleStatus } from '../src/lib/fleet-status'
import type { DashboardVehicle, Stop } from '../src/types/domain'

const NOW = new Date('2026-11-03T12:00:00Z').getTime()

function stop(partial: Partial<Stop> = {}): Stop {
  return { id: 's1', tourId: 't1', sequence: 1, type: 'UNLOAD', address: 'Hauptstraße 1, 08056 Zwickau', city: 'Zwickau', status: 'PLANNED', ...partial } as Stop
}

function row(partial: Partial<DashboardVehicle> = {}, number = '997'): DashboardVehicle {
  return { vehicle: { id: `v${number}`, vehicleNumber: number, licensePlate: `NOM-FX ${number}` }, statusText: 'MOVING', risk: 'GREEN', ...partial } as DashboardVehicle
}

describe('fleet status', () => {
  it('names the state the way the dispatcher says it', () => {
    expect(vehicleStatus(row(), NOW)).toEqual({ label: 'В пути', tone: 'ok' })
    expect(vehicleStatus(row({ delayMinutes: 35 }), NOW)).toEqual({ label: 'Опоздание', tone: 'late' })
    expect(vehicleStatus(row({ statusText: 'ARRIVED', currentStop: stop({ type: 'LOAD' }) }), NOW)).toEqual({ label: 'Загрузка', tone: 'stop' })
    expect(vehicleStatus(row({ statusText: 'WAITING_FOR_START', tour: { id: 't1', stops: [stop()] } as never }), NOW)).toEqual({ label: 'Запланирован', tone: 'plan' })
    expect(vehicleStatus(row({ statusText: 'IDLE' }), NOW)).toEqual({ label: 'Без тура', tone: 'idle' })
  })

  it('shows where the truck goes and the reserve before Termin', () => {
    const moving = row({
      from: stop({ city: 'Göttingen' }), to: stop({ city: 'Zwickau' }),
      telemetry: { source: 'WEBFLEET', stale: false, address: 'A38, Leinefelde' },
      eta: '2026-11-03T14:10:00Z', tour: { id: 't1', stops: [stop({ appointmentAt: '2026-11-03T15:00:00Z' })] } as never
    })
    expect(vehiclePlace(moving)).toBe('A38 → Zwickau')
    expect(terminMargin(moving)).toBe(50)
    expect(terminMargin(row({ delayMinutes: 35 }))).toBe(-35)
    expect(terminMargin(row())).toBeNull()
  })

  it('always says where the position comes from', () => {
    expect(positionSource(row({ telemetry: { source: 'WEBFLEET', stale: false, ageSeconds: 70 } }), NOW)).toMatchObject({ kind: 'live', short: 'GPS 1 мин' })
    expect(positionSource(row({ telemetry: { source: 'WEBFLEET', stale: true, ageSeconds: 720 } }), NOW)).toMatchObject({ kind: 'stale', short: 'GPS 12 мин' })
    expect(positionSource(row(), NOW)).toMatchObject({ kind: 'calculated', short: 'расчёт' })
  })

  it('«Решить» holds open questions and alarms, not calm trucks', () => {
    const notified = new Set(['v312'])
    expect(needsDecision(row({}, '312'), notified, NOW)).toBe(true)
    expect(needsDecision(row({ delayMinutes: 20 }), new Set(), NOW)).toBe(true)
    expect(needsDecision(row(), new Set(), NOW)).toBe(false)
    expect(matchesFleetFilter(row({}, '312'), 'DECIDE', notified, NOW)).toBe(true)
  })

  it('puts Termin today between alarms and calm trucks', () => {
    const late = row({ delayMinutes: 10 }, '1410')
    const today = row({ tour: { id: 't', stops: [stop({ appointmentAt: '2026-11-03T16:00:00Z' })] } as never }, '949')
    const calm = row({}, '125')
    const sorted = [calm, today, late].sort((a, b) => compareVehicles(a, b, [], 'URGENCY', NOW))
    expect(sorted.map((item) => item.vehicle.vehicleNumber)).toEqual(['1410', '949', '125'])
    expect([today, calm, late].sort((a, b) => compareVehicles(a, b, [], 'NUMBER', NOW)).map((item) => item.vehicle.vehicleNumber)).toEqual(['125', '949', '1410'])
  })
})
