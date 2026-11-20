import { describe, expect, it } from 'vitest'

import { compareVehicles, getAttention, liveSpeed, manuallyStopped, matchesFleetFilter, needsDecision, notStarted, plannedStart, positionSource, activityNote, restNote, runsLate, terminMargin, terminNeeded, vehiclePlace, vehicleStatus } from '../src/lib/fleet-status'
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
    expect(vehicleStatus(row({ statusText: 'WAITING', currentStop: stop({ type: 'LOAD', arrivedAt: '2026-11-03T11:30:00Z' }) }), NOW)).toEqual({ label: 'Загрузка', tone: 'stop' })
    // The timer alone never puts a truck at the stop: 997 was shown «Прибыл» while still driving.
    expect(vehicleStatus(row({ statusText: 'ARRIVED', predictedArrival: true, currentStop: stop({ type: 'LOAD' }) }), NOW)).toEqual({ label: 'В пути', tone: 'ok' })
    expect(needsDecision(row({ statusText: 'ARRIVED', predictedArrival: true }), new Set(), NOW)).toBe(false)
    expect(vehicleStatus(row({ statusText: 'WAITING_FOR_START', tour: { id: 't1', stops: [stop()] } as never }), NOW)).toEqual({ label: 'Запланирован', tone: 'plan' })
    expect(vehicleStatus(row({ statusText: 'IDLE' }), NOW)).toEqual({ label: 'Без тура', tone: 'idle' })
  })

  it('a tour that has not begun is a plan, a truck stopped by hand is stopped, a planned break stays a break (owner, 18.11)', () => {
    const first = stop({ id: 's1', sequence: 1, type: 'LOAD', company: 'Demo Lager', city: 'Göttingen', appointmentAt: '2026-11-03T18:00:00Z' })
    const tour = { id: 't1', plannedStartAt: '2026-11-03T18:00:00Z', stops: [first, stop({ id: 's2', sequence: 2 })] } as never
    // No leg is driven and nothing is recorded: the server says WAITING, the page said «Пауза» in green.
    const planned = row({ statusText: 'WAITING', tour, currentStop: first, currentAction: { type: 'MARK_LOADED', label: 'BELADEN', stopId: 's1', manual: true, withoutGpsArrival: true } })
    expect(notStarted(planned)).toBe(true)
    expect(vehicleStatus(planned, NOW)).toEqual({ label: 'Запланирован', tone: 'plan' })
    expect(vehiclePlace(planned)).toBe('→ Demo Lager Göttingen')
    expect(plannedStart(planned)).toBe('2026-11-03T18:00:00Z')
    expect(matchesFleetFilter(planned, 'PLANNED', new Set(), NOW)).toBe(true)
    expect(matchesFleetFilter(planned, 'AT_STOP', new Set(), NOW)).toBe(false)
    // Fresh GPS shows it already rolling to the first stop.
    const rolling = row({ ...planned, telemetry: { source: 'WEBFLEET', stale: false, speedKmh: 72, address: 'A7, Northeim' } })
    expect(vehicleStatus(rolling, NOW)).toEqual({ label: 'В пути', tone: 'ok' })
    expect(vehiclePlace(rolling)).toBe('A7 → Demo Lager Göttingen')
    expect(matchesFleetFilter(rolling, 'PLANNED', new Set(), NOW)).toBe(false)
    // «Стоп» on the road: stopped, with the stop still ahead — not standing at it.
    const onLeg = { statusText: 'WAITING', tour, from: first, to: stop({ id: 's2', sequence: 2, city: 'Zwickau' }), currentStop: stop({ id: 's2', sequence: 2, city: 'Zwickau' }) } as const
    const halted = row({ ...onLeg, currentAction: { type: 'RESUME', label: 'Продолжить', stopId: null } })
    expect(manuallyStopped(halted)).toBe(true)
    expect(notStarted(halted)).toBe(false)
    expect(vehicleStatus(halted, NOW)).toEqual({ label: 'Остановлена', tone: 'stop' })
    expect(vehiclePlace(halted)).toBe('Demo Lager Göttingen → Zwickau')
    // A break of the calculated plan on the way is still a break.
    expect(vehicleStatus(row({ ...onLeg, currentAction: { type: 'MARK_UNLOADED', label: 'ENTLADEN', stopId: 's2', manual: true } }), NOW)).toEqual({ label: 'Пауза', tone: 'ok' })
  })

  it('shows the speed of every truck with fresh GPS, the late one too; a stale reading is no speed', () => {
    const lateTruck = row({ delayMinutes: 25, risk: 'RED', telemetry: { source: 'WEBFLEET', stale: false, speedKmh: 78.4 } })
    expect(vehicleStatus(lateTruck, NOW).tone).toBe('late')
    expect(liveSpeed(lateTruck)).toBe(78)
    expect(liveSpeed(row({ telemetry: { source: 'WEBFLEET', stale: true, speedKmh: 80 } }))).toBeNull()
    expect(liveSpeed(row({ telemetry: { source: 'CALCULATED', stale: false } }))).toBeNull()
  })

  it('marks daily rest at the stop as a known state: no long-stop alarm, the work goes on after the rest', () => {
    const resting = row({ statusText: 'WAITING', dwellMinutes: 300, dwellSeverity: 'NONE', currentAction: { type: 'MARK_LOADED', label: 'BELADEN', stopId: 's1' },
      currentStop: stop({ type: 'LOAD', arrivedAt: '2026-11-03T07:00:00Z' }),
      restAtStop: { stopId: 's1', stopType: 'LOAD', place: 'Düsseldorf', since: '2026-11-03T10:46:00Z', until: '2026-11-03T19:46:00Z' } })
    expect(vehicleStatus(resting, NOW)).toEqual({ label: 'Суточный отдых', tone: 'stop' })
    expect(restNote(resting, NOW)).toBe(`Суточный отдых до ${new Date('2026-11-03T19:46:00Z').toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · потом загрузка`)
    expect(getAttention(resting, NOW)).toMatchObject({ label: 'Суточный отдых', tone: 'watch' })
    expect(needsDecision(resting, new Set(), NOW)).toBe(false)
    expect(restNote(row(), NOW)).toBeNull()
  })

  it('a long stop with driving time left is a break, not daily rest; waiting and work are named too', () => {
    const time = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    const atDock = { statusText: 'WAITING', dwellMinutes: 200, currentStop: stop({ type: 'LOAD', arrivedAt: '2026-11-03T08:40:00Z' }) } as const
    const activity = { stopId: 's1', stopType: 'LOAD' as const, place: 'Düsseldorf', until: null, drivingLeftMs: 150 * 60_000, shiftEndAt: '2026-11-03T17:00:00Z' }
    const resting = row({ ...atDock, stopActivity: { ...activity, kind: 'BREAK', since: '2026-11-03T09:10:00Z' } })
    expect(vehicleStatus(resting, NOW)).toEqual({ label: 'Пауза', tone: 'stop' })
    expect(activityNote(resting, NOW)).toBe(`Пауза с ${time('2026-11-03T09:10:00Z')} · вождения ещё 2 ч 30 мин · смена до ${time('2026-11-03T17:00:00Z')}`)
    // A break is not the explained daily rest: a long stop still reaches the dispatcher.
    expect(getAttention(resting, NOW).label).not.toBe('Суточный отдых')
    const waiting = row({ ...atDock, stopActivity: { ...activity, kind: 'WAITING', since: '2026-11-03T11:00:00Z' } })
    expect(vehicleStatus(waiting, NOW)).toEqual({ label: 'Загрузка', tone: 'stop' })
    expect(activityNote(waiting, NOW)).toBe(`Ждёт с ${time('2026-11-03T11:00:00Z')} · готовность`)
    expect(activityNote(row({ ...atDock, stopActivity: { ...activity, kind: 'WORKING', since: null } }), NOW)).toBe('Идёт работа')
    expect(activityNote(row(), NOW)).toBeNull()
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

  it('a truck that arrives inside the Termin window is on time; late only after the window ends (owner, 20.11)', () => {
    const windowed = (eta: string) => row({ eta, delayMinutes: 0, to: stop({ city: 'Ketzür' }),
      tour: { id: 't1', stops: [stop({ type: 'LOAD', appointmentWindowStartAt: '2026-11-20T07:00:00Z', appointmentWindowEndAt: '2026-11-20T15:00:00Z' })] } as never })
    // B CY 7446: Termin 08:00–16:00, ETA 12:16 was shown as «опоздание 4 ч 17 мин».
    const inside = windowed('2026-11-20T11:16:00Z')
    expect(terminMargin(inside)).toBe(224)
    expect(runsLate(inside, NOW)).toBe(false)
    expect(vehicleStatus(inside, NOW)).toEqual({ label: 'В пути', tone: 'ok' })
    const after = windowed('2026-11-20T15:40:00Z')
    expect(terminMargin(after)).toBe(-40)
    expect(runsLate(after, NOW)).toBe(true)
    expect(terminMargin(windowed('2026-11-20T06:30:00Z'))).toBe(510)
  })

  it('«опаздывает» of the shift summary is a filter: ETA past the Termin or a delay on the way', () => {
    const tour = { id: 't1', stops: [stop({ appointmentAt: '2026-11-03T15:00:00Z' })] } as never
    const pastTermin = row({ eta: '2026-11-03T15:20:00Z', tour })
    const inTime = row({ eta: '2026-11-03T14:10:00Z', tour })
    expect(runsLate(pastTermin, NOW)).toBe(true)
    expect(runsLate(row({ delayMinutes: 35 }), NOW)).toBe(true)
    expect(runsLate(inTime, NOW)).toBe(false)
    expect(runsLate(row({ statusText: 'IDLE' }), NOW)).toBe(false)
    expect([pastTermin, inTime, row({ delayMinutes: 35 })].filter((item) => matchesFleetFilter(item, 'LATE', new Set(), NOW))).toHaveLength(2)
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

  it('waits for a Termin once per place: the Leergut stop after unloading at the same plant needs none', () => {
    const tour = (stops: Stop[]) => ({ id: 't1', stops }) as never
    const unload = stop({ id: 'u', sequence: 1, terminRequired: true })
    const leergut = stop({ id: 'l', sequence: 2, type: 'LOAD', terminRequired: false, terminSharedWithStopId: 'u' })
    expect(terminNeeded(row({ tour: tour([unload, leergut]) }))).toBe(true)
    expect(matchesFleetFilter(row({ tour: tour([unload, leergut]) }), 'NO_TERMIN', new Set(), NOW)).toBe(true)
    const done = { ...unload, appointmentAt: '2026-11-03T07:00:00Z', completedAt: '2026-11-03T08:30:00Z' }
    expect(terminNeeded(row({ tour: tour([done, leergut]) }))).toBe(false)
    // An older record may still carry the flag: the pair decides, not the flag.
    expect(terminNeeded(row({ tour: tour([done, { ...leergut, terminRequired: true }]) }))).toBe(false)
    expect(terminNeeded(row({ tour: tour([done, { ...leergut, terminRequired: true, terminSharedWithStopId: null }]) }))).toBe(true)
  })
})
