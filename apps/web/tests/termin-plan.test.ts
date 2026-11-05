import { describe, expect, it } from 'vitest'
import { candidateText, isTerminPlan, isVehicleBrief, positionText, segmentLabel, sourceText, timelineRows } from '../src/lib/termin-plan'

const now = new Date('2026-11-05T08:00:00Z')

describe('Termin plan card helpers', () => {
  it('lists the timeline in Berlin time with the pause marked', () => {
    const rows = timelineRows({ timeline: [
      { type: 'DRIVE', startAt: '2026-11-05T08:00:00Z', endAt: '2026-11-05T09:00:00Z', startLocal: '09:00', endLocal: '10:00', durationSeconds: 3600, label: 'Движение → Выгрузка · Hannover', stopId: 's1' },
      { type: 'BREAK', startAt: '2026-11-05T09:00:00Z', endAt: '2026-11-05T09:45:00Z', startLocal: '10:00', endLocal: '10:45', durationSeconds: 2700, label: '', stopId: 's1' },
      { type: 'DAILY_REST', startAt: '2026-11-05T18:00:00Z', endAt: '2026-11-06T05:00:00Z', startLocal: '19:00', endLocal: '06.11, 06:00', durationSeconds: 39600, label: '', stopId: null }
    ] }, now)
    expect(rows.map((row) => [row.time, row.until, row.text, row.pause])).toEqual([
      ['09:00', '10:00', 'Движение → Выгрузка · Hannover · 1 ч', false],
      ['10:00', '10:45', 'Перерыв · 45 мин', true],
      ['19:00', '06.11, 06:00', 'Суточный отдых · 11 ч', true]
    ])
    expect(segmentLabel('WAIT')).toBe('Ожидание Termin')
  })
  it('explains candidates and the source of the hours', () => {
    expect(candidateText({ label: 'Текущий Termin', at: '2026-11-05T10:30:00Z', atLocal: '11:30', verdict: 'LATE', deltaMinutes: 30, note: 'опоздание 30 мин даже при минимальных стоянках.' }))
      .toBe('11:30 · опоздание 30 мин даже при минимальных стоянках.')
    expect(candidateText({ label: 'По запросу', at: '2026-11-05T12:00:00Z', atLocal: '13:00', verdict: 'OK', deltaMinutes: 10, note: '' })).toBe('13:00 · успевает')
    expect(sourceText({ source: 'WEBFLEET', preliminary: false })).toBe('по тахографу Webfleet')
    expect(sourceText({ source: 'CALCULATED', preliminary: true })).toBe('по расчётным часам машины · предварительно')
    expect(positionText({ status: 'MOVING', state: 'UNTERWEGS', address: 'A7, Göttingen', source: 'WEBFLEET', ageMinutes: 2, stale: false, remainingKm: 120 })).toBe('A7, Göttingen · Webfleet, 2 мин назад · осталось ≈ 120 км')
    expect(positionText({ status: 'IDLE', state: 'NO_ACTIVE_ROUTE', address: null, source: null, ageMinutes: null, stale: false, remainingKm: null })).toBe('нет данных')
  })
  it('recognises plan and brief payloads only by their kind', () => {
    expect(isTerminPlan({ kind: 'TERMIN', timeline: [] })).toBe(true)
    expect(isTerminPlan({ kind: 'SCENARIO', timeline: [] })).toBe(false)
    expect(isVehicleBrief({ kind: 'VEHICLE_BRIEF', driver: { summary: '' } })).toBe(true)
    expect(isVehicleBrief(null)).toBe(false)
  })
})
