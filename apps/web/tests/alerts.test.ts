import { describe, expect, it } from 'vitest'

import { alertHeading, cardLink, pickNewAlerts, titleWithCount } from '../src/lib/alerts'
import { currentStopOf, followingTours, tourCancellable } from '../src/lib/tours'
import type { Tour } from '../src/types/domain'

const note = (id: string) => ({ id, vehicleId: 'veh-1', type: 'AUTO_ARRIVAL', message: id, createdAt: '2026-11-03T12:00:00Z' })

describe('alerts', () => {
  it('turns the backlog of a new tab into one summary and rings only for new ones later', () => {
    const first = pickNewAlerts([note('a'), note('b')], null)
    expect(first).toEqual({ fresh: [], summary: 2, seen: ['a', 'b'] })
    const next = pickNewAlerts([note('a'), note('b'), note('c')], first.seen)
    expect(next.fresh.map((item) => item.id)).toEqual(['c'])
    expect(next.summary).toBe(0)
    expect(pickNewAlerts([note('a')], next.seen).fresh).toEqual([])
  })

  it('shows the count in the tab title and links to the truck card', () => {
    expect(titleWithCount(0)).toBe('OPS FOREX')
    expect(titleWithCount(3)).toBe('(3) OPS FOREX')
    expect(titleWithCount(140)).toBe('(99+) OPS FOREX')
    expect(cardLink('veh 1')).toBe('/?vehicleId=veh%201&card=veh%201')
    expect(alertHeading('TRAFFIC_DELAY')).toBe('Пробка на маршруте')
  })
})

describe('tours', () => {
  const stop = (id: string, sequence: number, extra = {}) => ({ id, tourId: 't', sequence, type: 'LOAD', address: id, latitude: 0, longitude: 0, ...extra }) as NonNullable<Tour['stops']>[number]
  const tour = (status: Tour['status'], stops: NonNullable<Tour['stops']>, events: unknown[] = []) => ({ id: status, vehicleId: 'v', orderNumber: '1', status, stops, events }) as Tour

  it('allows removing a tour only before the first arrival or BELADEN', () => {
    expect(tourCancellable(tour('QUEUED', [stop('a', 1)]))).toBe(true)
    expect(tourCancellable(tour('ACTIVE', [stop('a', 1)]))).toBe(true)
    expect(tourCancellable(tour('ACTIVE', [stop('a', 1, { arrivedAt: '2026-11-03T12:39:00Z' })]))).toBe(false)
    expect(tourCancellable(tour('QUEUED', [stop('a', 1)], [{}]))).toBe(false)
    expect(tourCancellable(tour('COMPLETED', [stop('a', 1)]))).toBe(false)
  })

  it('finds the stop the truck is at even after arrival, and the tours waiting after the current one', () => {
    const current = tour('ACTIVE', [stop('b', 2), stop('a', 1, { arrivedAt: '2026-11-03T12:39:00Z' })])
    expect(currentStopOf(current)?.id).toBe('a')
    expect(followingTours([current, tour('QUEUED', []), tour('CANCELLED', [])], 'ACTIVE').map((item) => item.status)).toEqual(['QUEUED'])
  })
})

describe('termin label', () => {
  const stop = (extra = {}) => ({ id: 's', tourId: 't', sequence: 1, type: 'UNLOAD', address: 'x', latitude: 0, longitude: 0, ...extra }) as NonNullable<Tour['stops']>[number]
  it('shows the slot of the next open stop, exact or window, in Berlin time', async () => {
    const { terminOf } = await import('../src/lib/tours')
    expect(terminOf({ stops: [stop({ appointmentAt: '2026-11-04T10:00:00Z' })] })?.label).toBe('Termin 04.11 11:00')
    expect(terminOf({ stops: [stop({ appointmentWindowStartAt: '2026-11-04T08:00:00Z', appointmentWindowEndAt: '2026-11-04T08:30:00Z' })] })?.label).toBe('Termin 04.11 09:00–09:30')
    expect(terminOf({ stops: [stop({ appointmentAt: '2026-11-04T10:00:00Z', completedAt: '2026-11-04T10:30:00Z' }), stop({ id: 's2', sequence: 2 })] })).toBeNull()
    expect(terminOf(null)).toBeNull()
  })
})
