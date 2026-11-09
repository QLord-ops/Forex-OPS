import { describe, expect, it } from 'vitest'
import { driverHoursLine, etaPlanLine } from '../src/lib/fleet-status'
import { formatDateTime } from '../src/lib/format'

const NOW = new Date('2026-11-05T12:00:00Z').getTime()
const time = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

describe('driver hours line in the bottom panel', () => {
  it('reads the tachograph and says how old it is', () => {
    const line = driverHoursLine({ referenceTime: '2026-11-05T11:57:00Z', remainDrivingTodayMs: 97 * 60_000, nextBreakAt: '2026-11-05T12:45:00Z', nextRestAt: '2026-11-05T20:15:00Z', latestShiftEndAt: '2026-11-05T21:00:00Z' }, null, NOW)!
    expect(line.parts.map((part) => `${part.label} ${part.value}`)).toEqual(['Вождение: осталось 1 ч 37 мин', 'До перерыва 45 мин', `Суточный отдых не позже ${time('2026-11-05T20:15:00Z')}`, `Смена до ${time('2026-11-05T21:00:00Z')}`])
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

describe('what is left to the stop in the bottom panel', () => {
  const eta = '2026-11-06T05:52:00Z'
  it('shows the driving time and the daily rest on the way when the ETA follows the tachograph', () => {
    const line = etaPlanLine({ eta, etaSource: 'GPS', etaPlan: { hours: 'TACHOGRAPH', preliminary: false, driveSeconds: 6 * 3600 + 12 * 60, breakSeconds: 0,
      rest: { startAt: '2026-11-05T17:56:00Z', endAt: '2026-11-06T04:56:00Z', seconds: 11 * 3600, reduced: false }, startsAt: null } }, NOW)
    expect(line).toEqual({ text: `≈ 6 ч 12 мин езды · отдых 11 ч до ${formatDateTime('2026-11-06T04:56:00Z')}`, source: 'от GPS · по тахографу' })
  })
  it('names a reduced rest and a break, and says when a driver whose card is out may leave', () => {
    expect(etaPlanLine({ eta, etaSource: 'CALCULATED', etaPlan: { hours: 'TACHOGRAPH', preliminary: false, driveSeconds: 2 * 3600, breakSeconds: 0,
      rest: { startAt: '2026-11-05T12:00:00Z', endAt: '2026-11-05T21:00:00Z', seconds: 9 * 3600, reduced: true }, startsAt: null } }, NOW).text).toBe(`≈ 2 ч езды · отдых 9 ч (сокращён) до ${time('2026-11-05T21:00:00Z')}`)
    expect(etaPlanLine({ eta, etaSource: 'GPS', etaPlan: { hours: 'TACHOGRAPH', preliminary: false, driveSeconds: 5 * 3600, breakSeconds: 45 * 60, rest: null, startsAt: null } }, NOW).text).toBe('≈ 5 ч езды · перерыв 45 мин')
    expect(etaPlanLine({ eta, etaSource: 'CALCULATED', etaPlan: { hours: 'TACHOGRAPH', preliminary: false, driveSeconds: 3600, breakSeconds: 0, rest: null, startsAt: '2026-11-05T14:30:00Z' } }, NOW).text).toBe(`≈ 1 ч езды · выезд не раньше ${time('2026-11-05T14:30:00Z')}`)
  })
  it('falls back to the time until the ETA without a plan and marks calculated hours as preliminary', () => {
    expect(etaPlanLine({ eta: new Date(NOW + 90 * 60_000).toISOString(), etaSource: 'CALCULATED', etaPlan: null }, NOW)).toEqual({ text: '≈ 1 ч 30 мин до точки', source: 'расчёт' })
    expect(etaPlanLine({ eta: null, etaSource: 'GPS' }, NOW)).toEqual({ text: 'время неизвестно', source: 'от GPS' })
    expect(etaPlanLine({ eta, etaSource: 'GPS', etaPlan: { hours: 'CLOCK', preliminary: true, driveSeconds: 3600, breakSeconds: 0, rest: null, startsAt: null } }, NOW).source).toBe('от GPS · часы предварительно')
  })
})
