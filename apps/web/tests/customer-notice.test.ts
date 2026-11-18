import { describe, expect, it } from 'vitest'

import { draftNotice, noticeDue, noticeLine } from '../src/lib/customer-notice'
import type { DashboardVehicle, Stop } from '../src/types/domain'

const stop = (id: string, extra: Partial<Stop> = {}): Stop => ({ id, tourId: 't1', sequence: 2, type: 'UNLOAD', company: 'Musterwerk Jena', address: 'Werkstraße 1, 07745 Jena', city: 'Jena',
  latitude: 50.9, longitude: 11.6, serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivedAt: null, completedAt: null, appointmentAt: '2026-11-18T13:25:00.000Z', ...extra } as Stop)

function row(extra: Partial<DashboardVehicle> = {}, stopExtra: Partial<Stop> = {}): DashboardVehicle {
  return {
    vehicle: { id: 'v187', vehicleNumber: '187', licensePlate: 'GÖ FX 187', maxSpeedKmh: 85 },
    customer: { id: 'c1', name: 'Musterwerk', slug: 'MUSTERWERK', color: null },
    tour: { id: 't1', vehicleId: 'v187', orderNumber: 'FX-48211', status: 'ACTIVE', stops: [stop('s1', { sequence: 1, type: 'LOAD', completedAt: '2026-11-18T08:40:00.000Z' }), stop('s2', stopExtra)], legs: [] },
    statusText: 'MOVING', risk: 'RED', eta: '2026-11-18T14:05:00.000Z', delayMinutes: 40,
    telemetry: { source: 'WEBFLEET', stale: false, speedKmh: 78 },
    ...extra
  } as DashboardVehicle
}

describe('«Сообщить заказчику» (owner, 18.11.2026: при опоздании)', () => {
  it('is offered when the truck will miss the Termin or keeps less than 15 minutes, never without a customer or at the stop', () => {
    expect(noticeDue(row())).toBe(true)
    expect(noticeDue(row({ delayMinutes: 0, eta: '2026-11-18T13:15:00.000Z' }))).toBe(true)
    expect(noticeDue(row({ delayMinutes: 0, eta: '2026-11-18T12:55:00.000Z' }))).toBe(false)
    expect(noticeDue(row({ customer: null }))).toBe(false)
    expect(noticeDue(row({}, { arrivedAt: '2026-11-18T13:50:00.000Z' }))).toBe(false)
    expect(noticeDue(row({}, { appointmentAt: null }))).toBe(false)
  })

  it('drafts a German letter with the truck, the order, the place, the Termin and the new arrival in Berlin time', () => {
    const { subject, body } = draftNotice(row(), 'Stau auf der Strecke', 'Anna Demo')
    expect(subject).toBe('Verspätung LKW 187 · Auftrag FX-48211 · Jena')
    expect(body).toContain('unser LKW 187 (GÖ FX 187) zum Auftrag FX-48211 kommt später als geplant.')
    expect(body).toContain('Entladung: Musterwerk Jena, Werkstraße 1, 07745 Jena')
    expect(body).toContain('Termin: 18.11.2026, 14:25')
    expect(body).toContain('Voraussichtliche Ankunft: 18.11.2026, 15:05 (ca. 40 Min. später)')
    expect(body).toContain('Grund: Stau auf der Strecke')
    expect(body.trim().endsWith('Anna Demo\nForex GmbH · Disposition')).toBe(true)
    expect(draftNotice(row({ delayMinutes: 0, eta: '2026-11-18T13:15:00.000Z' }), '', 'X').body).not.toContain('Grund:')
  })

  it('says who told the customer and when, only for the stop the truck drives to now', () => {
    expect(noticeLine(row())).toBeNull()
    const told = row({ customerNotice: { at: '2026-11-18T12:45:00.000Z', by: 'Anna Demo', channel: 'EMAIL', stopId: 's2', etaAt: null, delayMinutes: 40 } })
    expect(noticeLine(told)).toMatch(/^Заказчик уведомлён \d{2}:45, Anna Demo$/)
    expect(noticeLine(row({ customerNotice: { at: '2026-11-18T12:45:00.000Z', by: 'Anna', channel: 'COPY', stopId: 's1', etaAt: null, delayMinutes: null } }))).toBeNull()
  })
})
