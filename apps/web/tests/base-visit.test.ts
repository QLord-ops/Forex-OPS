import { describe, expect, it } from 'vitest'
import { baseChip, headsToBase, weekdayClock, weekKey, weekLabel } from '../src/lib/base-visit'
import type { BaseVisit, DashboardVehicle } from '../src/types/domain'

const visit = (patch: Partial<BaseVisit>): BaseVisit => ({ id: 'v', weekStart: '2026-11-16', dueAt: '2026-11-20T17:00:00.000Z', freeAt: '2026-11-23T05:00:00.000Z',
  arrivedAt: null, arrivedSource: null, expectedAt: null, state: 'DUE', ...patch })

describe('the truck\'s week at the base', () => {
  it('writes the weekday and the Berlin time', () => {
    expect(weekdayClock('2026-11-20T17:00:00.000Z')).toBe('пт 18:00')
    expect(weekdayClock('2026-11-23T05:00:00.000Z')).toBe('пн 06:00')
  })
  it('says where the truck stands with the deadline', () => {
    expect(baseChip(null)).toBeNull()
    expect(baseChip(visit({}))).toMatchObject({ label: 'на базу до пт 18:00', tone: 'plain' })
    expect(baseChip(visit({ state: 'TIGHT', expectedAt: '2026-11-21T13:00:00.000Z' }))).toMatchObject({ label: 'на базу до пт 18:00 · не успевает', tone: 'late' })
    expect(baseChip(visit({ state: 'TIGHT', expectedAt: '2026-11-21T13:00:00.000Z' }))!.title).toContain('сб 14:00')
    expect(baseChip(visit({ state: 'OVERDUE' }))).toMatchObject({ label: 'на базу: срок прошёл', tone: 'late' })
    expect(baseChip(visit({ state: 'AT_BASE', arrivedAt: '2026-11-20T14:30:00.000Z', arrivedSource: 'WEBFLEET_AUTO' }))).toMatchObject({ label: 'на базе до пн 06:00', tone: 'ok' })
    expect(baseChip(visit({ state: 'AT_BASE', arrivedAt: '2026-11-20T14:30:00.000Z', arrivedSource: 'WEBFLEET_AUTO' }))!.title).toContain('GPS Webfleet')
  })
  it('counts a truck as heading home until it stands at the base', () => {
    const row = (baseVisit: BaseVisit | null) => ({ baseVisit }) as DashboardVehicle
    expect(headsToBase(row(visit({})))).toBe(true)
    expect(headsToBase(row(visit({ state: 'AT_BASE' })))).toBe(false)
    expect(headsToBase(row(null))).toBe(false)
  })
  it('names this week and the next by their Berlin Monday', () => {
    const friday = Date.parse('2026-11-20T12:00:00Z')
    expect(weekKey(friday)).toBe('2026-11-16')
    expect(weekKey(friday, 1)).toBe('2026-11-23')
    expect(weekKey(Date.parse('2026-11-22T23:30:00Z'))).toBe('2026-11-23')
    expect(weekLabel('2026-11-16')).toBe('16.11–22.11')
  })
})
