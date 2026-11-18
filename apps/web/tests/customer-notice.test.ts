import { describe, expect, it } from 'vitest'

import { draftNotice, noticeDue, noticeKind, noticeLine, placeText, waitsAtStop, waitText } from '../src/lib/customer-notice'
import type { DashboardVehicle, Stop } from '../src/types/domain'

const stop = (id: string, extra: Partial<Stop> = {}): Stop => ({ id, tourId: 't1', sequence: 2, type: 'UNLOAD', company: 'MB', address: 'Werkstraße 1, 40001 Düsseldorf', city: 'Düsseldorf',
  latitude: 51.2, longitude: 6.8, serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivedAt: null, completedAt: null, appointmentAt: '2026-11-18T11:00:00.000Z', ...extra } as Stop)

function row(extra: Partial<DashboardVehicle> = {}, stopExtra: Partial<Stop> = {}): DashboardVehicle {
  return {
    vehicle: { id: 'v131', vehicleNumber: '131', licensePlate: 'GÖ FX 131', maxSpeedKmh: 85 },
    customer: { id: 'c1', name: 'Musterwerk', slug: 'MUSTERWERK', color: null },
    tour: { id: 't1', vehicleId: 'v131', orderNumber: 'FX-48211', status: 'ACTIVE', stops: [stop('s1', { sequence: 1, type: 'LOAD', completedAt: '2026-11-18T08:40:00.000Z' }), stop('s2', stopExtra)], legs: [] },
    statusText: 'MOVING', risk: 'RED', eta: '2026-11-18T13:20:00.000Z', delayMinutes: 140,
    telemetry: { source: 'WEBFLEET', stale: false, speedKmh: 78 },
    ...extra
  } as DashboardVehicle
}
const waiting = (minutes: number, type: 'LOAD' | 'UNLOAD' = 'UNLOAD') => row({ statusText: 'ARRIVED', dwellMinutes: minutes, eta: null, delayMinutes: 0,
  currentStop: stop('s2', { type, arrivedAt: new Date(Date.now() - minutes * 60_000).toISOString() }) }, { type, arrivedAt: new Date(Date.now() - minutes * 60_000).toISOString() })

describe('«Сообщить заказчику» (owner, 18.11.2026)', () => {
  it('is offered when the truck will miss the Termin or keeps less than 15 minutes, or waits an hour at the stop', () => {
    expect(noticeKind(row())).toBe('LATE')
    expect(noticeKind(row({ delayMinutes: 0, eta: '2026-11-18T10:50:00.000Z' }))).toBe('LATE')
    expect(noticeDue(row({ delayMinutes: 0, eta: '2026-11-18T10:30:00.000Z' }))).toBe(false)
    expect(noticeDue(row({ customer: null }))).toBe(false)
    expect(noticeDue(row({}, { appointmentAt: null }))).toBe(false)
    expect(noticeKind(waiting(65))).toBe('WAITING')
    expect(noticeDue(waiting(30))).toBe(false)
  })

  const noon = Date.parse('2026-11-18T10:00:00.000Z')
  it('writes one line as the dispatchers do, the truck number as the subject, no signature (Outlook adds it)', () => {
    expect(draftNotice(row(), 'LATE', false, noon)).toEqual({ subject: '131', body: 'Hallo, der Fahrer verspätet sich zum Termin um 12 Uhr bei MB Düsseldorf, er wird voraussichtlich gegen 14:20 Uhr da sein' })
    expect(draftNotice(row(), 'LATE', true, noon).body).toBe('Hallo, der Fahrer verspätet sich zum Termin um 12 Uhr bei MB Düsseldorf, er steht im Stau und wird voraussichtlich gegen 14:20 Uhr da sein')
    expect(draftNotice(row({ delayMinutes: 0, eta: '2026-11-18T10:50:00.000Z' }, { appointmentAt: '2026-11-18T10:55:00.000Z' }), 'LATE', false, noon).body)
      .toBe('Hallo, der Fahrer schafft den Termin um 11:55 Uhr bei MB Düsseldorf nur knapp, er wird voraussichtlich gegen 11:50 Uhr da sein')
  })

  it('is whole German sentences: the wait as it was measured, the day with a time that is not today (owner, 18.11)', () => {
    expect(draftNotice(waiting(65), 'WAITING').body).toBe('Hallo, der Fahrer wartet seit 1 Stunde auf die Entladung bei MB Düsseldorf')
    expect(draftNotice(waiting(150, 'LOAD'), 'WAITING').body).toBe('Hallo, der Fahrer wartet seit 2,5 Stunden auf die Beladung bei MB Düsseldorf')
    // A truck on the road has no wait: the letter never invents «seit 1 Stunde».
    expect(waitsAtStop(row())).toBe(false)
    expect(waitsAtStop(waiting(5))).toBe(true)
    expect(draftNotice(row(), 'WAITING', false, noon).body).toBe('Hallo, der Fahrer wartet auf die Entladung bei MB Düsseldorf')
    // Termin 18:15 today, the truck comes after midnight: «morgen», and a later day by its date.
    const night = row({ eta: '2026-11-18T23:30:00.000Z', delayMinutes: 375 }, { appointmentAt: '2026-11-18T17:15:00.000Z' })
    expect(draftNotice(night, 'LATE', false, noon).body).toBe('Hallo, der Fahrer verspätet sich zum Termin um 18:15 Uhr bei MB Düsseldorf, er wird voraussichtlich morgen gegen 00:30 Uhr da sein')
    const later = row({ eta: '2026-11-20T07:05:00.000Z', delayMinutes: 65 }, { appointmentAt: '2026-11-20T06:00:00.000Z' })
    expect(draftNotice(later, 'LATE', false, noon).body).toBe('Hallo, der Fahrer verspätet sich zum Termin am 20.11. um 7 Uhr bei MB Düsseldorf, er wird voraussichtlich am 20.11. gegen 08:05 Uhr da sein')
    for (const body of [draftNotice(row(), 'LATE', true, noon).body, draftNotice(waiting(65), 'WAITING').body]) expect(body).not.toMatch(/[а-яё]|\bHi\b|erwartet auf/i)
  })

  it('names the plant without its legal form and the wait in German', () => {
    expect(placeText({ company: 'Schnellecke Transportlogistik GmbH', city: '38440 Wolfsburg' })).toBe('Schnellecke Wolfsburg')
    expect(placeText({ company: 'MAN Truck & Bus SE Salzgitter Werk', city: 'Salzgitter' })).toBe('MAN Salzgitter')
    expect(placeText({ company: '', city: 'Jena' })).toBe('Jena')
    expect(waitText(40)).toBe('40 Minuten')
    expect(waitText(120)).toBe('2 Stunden')
  })

  it('says who told the customer and when, only for the stop the truck drives to now', () => {
    expect(noticeLine(row())).toBeNull()
    const told = row({ customerNotice: { at: '2026-11-18T12:45:00.000Z', by: 'Anna Demo', channel: 'EMAIL', stopId: 's2', etaAt: null, delayMinutes: 40 } })
    expect(noticeLine(told)).toMatch(/^Заказчик уведомлён \d{2}:45, Anna Demo$/)
    expect(noticeLine(row({ customerNotice: { at: '2026-11-18T12:45:00.000Z', by: 'Anna', channel: 'COPY', stopId: 's1', etaAt: null, delayMinutes: null } }))).toBeNull()
  })
})
