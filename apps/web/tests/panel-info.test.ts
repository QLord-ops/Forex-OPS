import { describe, expect, it } from 'vitest'
import { driverHoursLine } from '../src/lib/fleet-status'

const NOW = new Date('2026-11-05T12:00:00Z').getTime()
const time = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

describe('driver hours line in the bottom panel', () => {
  it('reads the tachograph and says how old it is', () => {
    const line = driverHoursLine({ referenceTime: '2026-11-05T11:57:00Z', remainDrivingTodayMs: 97 * 60_000, nextBreakAt: '2026-11-05T12:45:00Z', nextRestAt: '2026-11-05T20:15:00Z', latestShiftEndAt: '2026-11-05T23:00:00Z' }, null, NOW)!
    expect(line.parts.map((part) => `${part.label} ${part.value}`)).toEqual(['Вождение: осталось 1 ч 37 мин', 'До перерыва 45 мин', `Суточный отдых не позже ${time('2026-11-05T20:15:00Z')}`, 'Смена до 06.11, 00:00'])
    expect(line).toMatchObject({ source: 'по тахографу Webfleet, 3 мин назад', stale: false })
  })
  it('flags old tachograph data and a break that is due', () => {
    const line = driverHoursLine({ referenceTime: '2026-11-05T11:00:00Z', remainDrivingTodayMs: 10 * 60_000, nextBreakAt: '2026-11-05T11:55:00Z', nextRestAt: null, latestShiftEndAt: null }, null, NOW)!
    expect(line.stale).toBe(true)
    expect(line.parts).toEqual([{ label: 'Вождение: осталось', value: '10 мин', warn: true }, { label: 'До перерыва', value: 'сейчас', warn: true }])
  })
  it('falls back to the calculated clock, marked preliminary, and says nothing without data', () => {
    expect(driverHoursLine(null, { preliminary: true, remainingDrivingMinutes: 240, breakInMinutes: 90 }, NOW)).toMatchObject({ source: 'расчёт OPS, предварительно', parts: [{ value: '4 ч' }, { value: '1 ч 30 мин' }] })
    expect(driverHoursLine(null, null, NOW)).toBeNull()
  })
})
