import { describe, expect, it } from 'vitest'

import { formatDelay, trafficIncidents } from '../src/lib/traffic-incidents'
import type { Coordinate } from '../src/types/domain'

// About 1.1 km between points along a meridian.
const line: Coordinate[] = Array.from({ length: 21 }, (_, index) => [10, 50 + index * 0.01])

describe('traffic incidents', () => {
  it('joins neighbouring pieces of one jam and sums the delay', () => {
    const [jam] = trafficIncidents(line, [
      { from: 4, to: 6, level: 'SLOW', delaySeconds: 40, speedKmh: 40 },
      { from: 7, to: 9, level: 'JAM', delaySeconds: 500, speedKmh: 12 }
    ])
    expect(jam).toMatchObject({ id: '4-9', level: 'JAM', delaySeconds: 540, speedKmh: 12, coordinate: line[4] })
    expect(jam.lengthMeters).toBeGreaterThan(5_400)
    expect(jam.lengthMeters).toBeLessThan(5_700)
    expect(jam.distanceAheadMeters).toBeGreaterThan(4_400)
    expect(jam.distanceAheadMeters).toBeLessThan(4_500)
  })

  it('marks every jam ahead, short slow-downs and closures included', () => {
    const result = trafficIncidents(line, [
      { from: 2, to: 3, level: 'SLOW', delaySeconds: 30 },
      { from: 10, to: 12, level: 'CLOSED' },
      { from: 15, to: 18, level: 'JAM', delaySeconds: 60 }
    ])
    expect(result.map((item) => item.level)).toEqual(['SLOW', 'CLOSED', 'JAM'])
  })

  it('counts from the truck and drops jams it has already passed', () => {
    const result = trafficIncidents(line, [
      { from: 1, to: 3, level: 'JAM', delaySeconds: 300 },
      { from: 6, to: 10, level: 'STANDSTILL', delaySeconds: 900 },
      { from: 14, to: 16, level: 'JAM', delaySeconds: 120 }
    ], { startIndex: 8 })
    expect(result.map((item) => item.id)).toEqual(['6-10', '14-16'])
    expect(result[0].distanceAheadMeters).toBe(0)
    expect(result[0].coordinate).toEqual(line[8])
    expect(result[1].distanceAheadMeters).toBeGreaterThan(6_600)
  })

  it('ignores broken indices and empty input', () => {
    expect(trafficIncidents(line, undefined)).toEqual([])
    expect(trafficIncidents(line, [{ from: 5, to: 5, level: 'JAM', delaySeconds: 600 }, { from: Number.NaN, to: 4, level: 'JAM', delaySeconds: 600 }])).toEqual([])
  })

  it('formats the delay for the dispatcher', () => {
    expect(formatDelay(720)).toBe('+12 мин')
    expect(formatDelay(4_500)).toBe('+1 ч 15 мин')
    expect(formatDelay(20)).toBe('<1 мин')
  })
})
