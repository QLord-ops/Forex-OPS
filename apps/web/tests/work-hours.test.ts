import { describe, expect, it } from 'vitest'

import { nightItems, planAlerts, summaryText, type AlertNotification } from '../src/lib/alerts'
import { DEFAULT_WORK_HOURS, isWorkTime, lastShiftEnd, validWorkHours, workHoursText } from '../src/lib/work-hours'

// November: Germany is UTC+1. 2026-11-05 is a Thursday, 2026-11-08 a Sunday.
const berlin = (date: string, time: string) => new Date(`${date}T${time}:00+01:00`)
const note = (id: string, extra: Partial<AlertNotification> = {}): AlertNotification => ({ id, vehicleId: 'v1', type: 'AUTO_ARRIVAL', message: id, createdAt: '2026-11-05T01:00:00Z', priority: 'INFO', ...extra })

describe('working day of the dispatcher', () => {
  it('is Mon–Sat 06:00–18:00 by default, Germany time', () => {
    expect(workHoursText(DEFAULT_WORK_HOURS)).toBe('Пн, Вт, Ср, Чт, Пт, Сб · 06:00–18:00')
    expect(isWorkTime(berlin('2026-11-05', '05:59'))).toBe(false)
    expect(isWorkTime(berlin('2026-11-05', '06:00'))).toBe(true)
    expect(isWorkTime(berlin('2026-11-05', '17:59'))).toBe(true)
    expect(isWorkTime(berlin('2026-11-05', '18:00'))).toBe(false)
    expect(isWorkTime(berlin('2026-11-07', '10:00'))).toBe(true)
    expect(isWorkTime(berlin('2026-11-08', '10:00'))).toBe(false)
  })

  it('knows when the last working day ended: yesterday evening, or Saturday evening on Monday', () => {
    expect(lastShiftEnd(berlin('2026-11-05', '07:00'))).toEqual(berlin('2026-11-04', '18:00'))
    expect(lastShiftEnd(berlin('2026-11-05', '19:00'))).toEqual(berlin('2026-11-05', '18:00'))
    expect(lastShiftEnd(berlin('2026-11-09', '06:30'))).toEqual(berlin('2026-11-07', '18:00'))
  })

  it('rejects an end before the start and unknown days', () => {
    expect(validWorkHours({ days: [1], start: '18:00', end: '06:00' })).toBe(false)
    expect(validWorkHours({ days: [7], start: '06:00', end: '18:00' })).toBe(false)
    expect(validWorkHours({ days: [], start: '07:00', end: '16:30' })).toBe(true)
  })
})

describe('quiet outside the working day', () => {
  const nightTime = berlin('2026-11-05', '02:00')
  const morning = berlin('2026-11-05', '06:01')

  it('at night only an urgent notification rings; the rest wait without a sound', () => {
    const departed = note('left', { type: 'STOP_DEPARTED', priority: 'ACTION', urgent: true })
    const plan = planAlerts([note('arrival'), departed, note('jam', { type: 'TRAFFIC_DELAY', priority: 'RISK' })], ['old'], [], nightTime, DEFAULT_WORK_HOURS)
    expect(plan.ring.map((item) => item.id)).toEqual(['left'])
    expect(plan.summary).toBeNull()
    expect(plan.deferred).toEqual(['arrival', 'jam'])
  })

  it('the first poll of the working day gives one summary of the night instead of a sound per item', () => {
    const items = [note('arrival'), note('jam', { type: 'TRAFFIC_DELAY', priority: 'RISK' }), note('termin', { type: 'APPOINTMENT_MATCH', priority: 'ACTION' })]
    const plan = planAlerts(items, ['arrival', 'jam', 'termin'], ['arrival', 'jam', 'termin'], morning, DEFAULT_WORK_HOURS)
    expect(plan.ring).toEqual([])
    expect(plan.summary).toEqual({ total: 3, decisions: 1, night: true })
    expect(summaryText(plan.summary!)).toBe('За ночь: 3 · требуют решения: 1')
    expect(plan.deferred).toEqual([])
    expect(planAlerts(items, plan.seen, plan.deferred, morning, DEFAULT_WORK_HOURS).summary).toBeNull()
  })

  it('during the day a new item rings as before; a notification that no longer applies does not', () => {
    const plan = planAlerts([note('a'), note('b', { resolved: true })], [], [], berlin('2026-11-05', '10:00'), DEFAULT_WORK_HOURS)
    expect(plan.ring.map((item) => item.id)).toEqual(['a'])
  })

  it('lists what came after the last working day ended as «За ночь»', () => {
    const items = [note('evening', { createdAt: berlin('2026-11-04', '17:00').toISOString() }), note('night', { createdAt: berlin('2026-11-05', '02:00').toISOString() }),
      note('today', { createdAt: berlin('2026-11-05', '06:30').toISOString() })]
    expect(nightItems(items, DEFAULT_WORK_HOURS, berlin('2026-11-05', '07:00')).map((item) => item.id)).toEqual(['night'])
    expect(nightItems(items, DEFAULT_WORK_HOURS, berlin('2026-11-05', '03:00'))).toEqual([])
  })
})
