import { describe, expect, it } from 'vitest'

import { centreOffset } from '../src/lib/map-padding'
import { stopDeadline, stopEta, stopTerminLabel } from '../src/lib/stop-times'
import { formatTime } from '../src/lib/format'
import type { Stop } from '../src/types/domain'

const NOW = new Date('2026-11-18T12:00:00Z')
const stop = (id: string, sequence: number, extra: Partial<Stop> = {}): Stop => ({ id, tourId: 't', sequence, type: 'UNLOAD', address: 'Werk 1', city: 'Kassel', latitude: 51.3, longitude: 9.5, ...extra } as Stop)

describe('Termin and ETA of every stop of a tour (owner, 18.11.2026)', () => {
  const unload = stop('s2', 2, { appointmentWindowStartAt: '2026-11-18T14:00:00Z', appointmentWindowEndAt: '2026-11-18T16:00:00Z' })
  const leergut = stop('s3', 3, { type: 'LOAD', terminSharedWithStopId: 's2' })
  const last = stop('s4', 4)
  const stops = [stop('s1', 1, { type: 'LOAD', appointmentAt: '2026-11-18T10:00:00Z' }), unload, leergut, last]

  it('names a window and a shared Termin instead of «Без срока»', () => {
    expect(stopTerminLabel(stops[0], stops)).toMatch(/^Termin 18\.11 \d{2}:00$/)
    expect(stopTerminLabel(unload, stops)).toMatch(/^Termin 18\.11 \d{2}:00–\d{2}:00$/)
    expect(stopTerminLabel(unload, stops, true)).toMatch(/^Termin \d{2}:00–\d{2}:00$/)
    expect(stopTerminLabel(leergut, stops)).toMatch(/^общий Termin с точкой 2 · 18\.11/)
    expect(stopTerminLabel(leergut, stops, true)).toBe('Termin точки 2')
    expect(stopTerminLabel(last, stops)).toBeNull()
    // The Leergut stop is late when it misses the end of the window it shares.
    expect(stopDeadline(leergut, stops)).toBe('2026-11-18T16:00:00Z')
  })

  it('shows one time: exact for the stop the truck drives to, «≈» with its range for the stops after it', () => {
    const exact = stopEta({ ...unload, predictedEta: '2026-11-18T15:10:00Z', etaEarliest: '2026-11-18T15:10:00Z', etaLatest: '2026-11-18T15:10:00Z', etaBasis: 'ETA' }, stops, NOW)
    expect(exact).toEqual({ text: `ETA ${formatTime('2026-11-18T15:10:00Z')}`, title: undefined, late: false })
    const later = stopEta({ ...leergut, predictedEta: '2026-11-18T16:40:00Z', etaEarliest: '2026-11-18T16:10:00Z', etaLatest: '2026-11-18T17:10:00Z', etaBasis: 'ETA' }, stops, NOW)
    expect(later.text).toBe(`ETA ≈ ${formatTime('2026-11-18T16:40:00Z')}`)
    expect(later.late).toBe(true)
    expect(later.title).toContain('от 1 до 2 часов')
    expect(stopEta({ ...last, predictedEta: null }, stops, NOW)).toEqual({ text: 'ETA нет', late: false })
    expect(stopEta({ ...unload, arrivedAt: '2026-11-18T11:20:00Z' }, stops, NOW).text).toBe(`на месте с ${formatTime('2026-11-18T11:20:00Z')}`)
  })

  it('says «по плану» while the tour has not begun, and keeps a later day readable in a narrow column', () => {
    const planned = stopEta({ ...last, predictedEta: '2026-11-19T10:53:00Z', etaEarliest: '2026-11-19T09:53:00Z', etaLatest: '2026-11-19T11:53:00Z', etaBasis: 'PLAN' }, stops, NOW, true)
    expect(planned.text).toBe(`по плану ≈ 19.11 ${formatTime('2026-11-19T10:53:00Z')}`)
    expect(planned.title).toContain('Тур ещё не начат')
    const tonight = stopEta({ ...last, predictedEta: '2026-11-18T23:30:00Z', etaEarliest: '2026-11-18T23:00:00Z', etaLatest: '2026-11-19T00:00:00Z', etaBasis: 'ETA' }, stops, NOW, true)
    expect(tonight.text).toBe(`ETA ≈ ${formatTime('2026-11-18T23:30:00Z')}`)
  })
})

describe('a truck is centred in the free part of the map', () => {
  it('moves the centre away from the list and the truck card, and stays put when nothing is free', () => {
    // 1280 px: the list and the card cover 772 px on the left, the folded questions nothing on the right.
    expect(centreOffset({ top: 96, right: 80, bottom: 136, left: 812 }, 1280, 720)).toEqual([366, -20])
    expect(centreOffset(64, 1280, 720)).toEqual([0, 0])
    expect(centreOffset({ top: 96, right: 432, bottom: 96, left: 812 }, 1280, 720)).toEqual([0, 0])
  })
})
