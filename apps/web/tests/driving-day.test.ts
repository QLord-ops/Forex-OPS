import { describe, expect, it } from 'vitest'
import { drivingDayText } from '../src/lib/driving-day'

describe('the driver\'s day at a stop', () => {
  it('says how much driving is left on arrival', () => {
    expect(drivingDayText(3 * 3600 + 20 * 60)).toEqual({ text: 'останется вождения 3 ч 20 мин', extended: false })
    expect(drivingDayText(30)).toEqual({ text: 'вождения на сегодня не останется', extended: false })
  })
  it('names the 10th hour taken for the Termin', () => {
    expect(drivingDayText(30 * 60, true)).toEqual({ text: '10-й час вождения ради Termin · останется вождения 30 мин', extended: true })
    expect(drivingDayText(null, true)).toEqual({ text: '10-й час вождения ради Termin', extended: true })
  })
  it('stays silent when the hours are unknown', () => {
    expect(drivingDayText(null)).toBeNull()
    expect(drivingDayText(undefined)).toBeNull()
  })
})
