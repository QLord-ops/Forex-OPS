import { beforeEach, describe, expect, it } from 'vitest'
import type { TourView } from '../src/api'
import { kept, serverNow, withPending } from '../src/offline'

class MemoryStorage {
  private items = new Map<string, string>()
  getItem(key: string) { return this.items.get(key) ?? null }
  setItem(key: string, value: string) { this.items.set(key, value) }
  removeItem(key: string) { this.items.delete(key) }
}

const stop = (id: string, sequence: number, patch: Record<string, unknown> = {}) => ({
  id, sequence, type: 'UNLOAD' as const, company: 'Volkswagen AG', address: 'Industriestraße Nord 1, 38239 Salzgitter', city: 'Salzgitter', latitude: 52.15, longitude: 10.4,
  appointmentAt: null, windowStartAt: null, windowEndAt: null, loadingMeters: null, references: [], instructions: null,
  arrivedAt: null, completedAt: null, samePlaceAsPrevious: false, undoUntil: null, ...patch
})
const view = (): TourView => ({
  serverTime: '2026-11-19T10:00:00.000Z', vehicle: { vehicleNumber: '214', licensePlate: 'GÖ-FX 214' }, next: null, lastMark: null,
  tour: { id: 't1', orderNumber: '4812', tourRemarks: null, trailerPlate: null, currentStopId: 's1', eta: null,
    stops: [stop('s1', 1, { arrivedAt: '2026-11-19T09:40:00.000Z' }), stop('s2', 2, { type: 'LOAD', samePlaceAsPrevious: true }), stop('s3', 3)] }
})
const truck = { vehicleNumber: '214', licensePlate: 'GÖ-FX 214' }

beforeEach(() => { (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage() })

describe('driver app without network', () => {
  it('shows kept marks on the tour and moves on to the next stop', () => {
    const first = kept.addMark(truck, 's1', 'done', new Date('2026-11-19T10:05:00Z'))
    kept.addMark(truck, 's2', 'done', new Date('2026-11-19T10:20:00Z'))
    const shown = withPending(view(), kept.marks(truck))
    expect(shown.tour!.currentStopId).toBe('s3')
    expect(shown.tour!.stops[0]).toMatchObject({ arrivedAt: '2026-11-19T09:40:00.000Z', completedAt: '2026-11-19T10:05:00.000Z', pending: true })
    // Leergut at the same plant: no «Прибыл» of its own, the mark is the arrival too.
    expect(shown.tour!.stops[1]).toMatchObject({ arrivedAt: '2026-11-19T10:20:00.000Z', completedAt: '2026-11-19T10:20:00.000Z', pending: true })
    expect(shown.tour!.stops[2].pending).toBeUndefined()
    kept.dropMark(first.id)
    expect(kept.marks(truck).map(mark => mark.stopId)).toEqual(['s2'])
  })

  it('keeps marks per truck, in the order they were pressed, and over a sign-out', () => {
    kept.addMark(truck, 's1', 'arrived', new Date('2026-11-19T10:00:00Z'))
    kept.addMark({ vehicleNumber: '936', licensePlate: 'KS-OP 936' }, 'x1', 'arrived', new Date('2026-11-19T10:01:00Z'))
    kept.addMark(truck, 's1', 'done', new Date('2026-11-19T10:30:00Z'))
    expect(kept.marks(truck).map(mark => mark.action)).toEqual(['arrived', 'done'])
    kept.forget()
    expect(kept.marks(truck)).toHaveLength(2)
    kept.dropMarksOf('s1', 'done')
    expect(kept.marks(truck).map(mark => mark.action)).toEqual(['arrived'])
  })

  it('dates a kept mark by the server clock, not by a wrong phone clock', () => {
    // The phone runs 7 minutes behind the server.
    const received = Date.parse('2026-11-19T09:53:00Z')
    kept.saveView(view(), received)
    expect(kept.view()!.offsetMs).toBe(7 * 60_000)
    expect(serverNow(kept.view()!.offsetMs, Date.parse('2026-11-19T10:03:00Z')).toISOString()).toBe('2026-11-19T10:10:00.000Z')
  })

  it('opens the app without network only while the shift still runs, and never keeps the CSRF token', () => {
    kept.saveSession({ authenticated: true, csrfToken: 'secret-token', expiresAt: '2026-11-19T20:00:00.000Z', vehicle: truck })
    expect(JSON.stringify(localStorage)).not.toContain('secret-token')
    expect(kept.session(Date.parse('2026-11-19T19:59:00Z'))).toEqual({ vehicle: truck, expiresAt: '2026-11-19T20:00:00.000Z' })
    expect(kept.session(Date.parse('2026-11-19T20:00:00Z'))).toBeNull()
  })
})

describe('driver app tabs', () => {
  it('dials only digits and a leading plus', async () => {
    const { telLink } = await import('../src/format')
    expect(telLink('+49 551 / 123-456')).toBe('tel:+49551123456')
    expect(telLink('0551 (99) 99 99')).toBe('tel:0551999999')
  })
})
