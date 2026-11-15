import { describe, expect, it } from 'vitest'

import { circlePolygon, formatCoordinate, formatDistance, googleMapsUrl, metersBetween, stopZones } from '../src/lib/stop-zone'
import { GERMANY_BOUNDS, inGermany } from '../src/lib/traffic-flow'
import type { Coordinate } from '../src/types/domain'

const BAUNATAL: Coordinate = [9.41, 51.25]
// ~111 m per 0.001 degree of latitude.
const north = (meters: number) => ({ latitude: BAUNATAL[1] + meters / 111_000, longitude: BAUNATAL[0] })

describe('the zone of a stop on the map', () => {
  it('is a closed ring whose every point lies the radius away from the address', () => {
    const circle = circlePolygon(BAUNATAL, 1000)
    const ring = circle.geometry.coordinates[0] as Coordinate[]
    expect(ring).toHaveLength(65)
    expect(ring[0]).toEqual(ring.at(-1))
    for (const point of ring) expect(metersBetween(BAUNATAL, point)).toBeGreaterThan(990)
    for (const point of ring) expect(metersBetween(BAUNATAL, point)).toBeLessThan(1010)
  })

  it('is 1 km by default, the dispatcher\'s own radius when chosen, and gone once the stop is done', () => {
    const far = { latitude: 53.55, longitude: 9.99 }
    expect(stopZones([{ ...north(0) }, far])).toEqual([{ center: BAUNATAL, radiusMeters: 1000 }, { center: [9.99, 53.55], radiusMeters: 1000 }])
    expect(stopZones([{ ...north(0), arrivalRadiusMeters: 2000 }, far])[0].radiusMeters).toBe(2000)
    expect(stopZones([{ ...north(0), completedAt: '2026-11-15T10:00:00Z' }, far])).toHaveLength(1)
  })

  it('draws one circle for unloading and loading at the same plant, and ends halfway to a next stop in the same town', () => {
    const samePlace = stopZones([{ ...north(0) }, { ...north(200) }, { latitude: 53.55, longitude: 9.99 }])
    expect(samePlace).toHaveLength(2)
    expect(samePlace[0]).toEqual({ center: BAUNATAL, radiusMeters: 1000 })
    // The first of the two is done, the second is not: the place is still ahead.
    expect(stopZones([{ ...north(0), completedAt: '2026-11-15T10:00:00Z' }, { ...north(200) }])).toHaveLength(1)
    const sameTown = stopZones([{ ...north(0) }, { ...north(1200) }])
    expect(Math.abs(sameTown[0].radiusMeters - 600)).toBeLessThan(5)
    expect(Math.round(stopZones([{ ...north(0) }, { ...north(350) }])[0].radiusMeters)).toBe(250)
  })
})

describe('the right-click menu of the map', () => {
  it('writes coordinates the way a navigator takes them and links the same spot in Google Maps', () => {
    expect(formatCoordinate(51.312345678, 9.4801234)).toBe('51.31235, 9.48012')
    expect(googleMapsUrl(51.312345678, 9.4801234)).toBe('https://www.google.com/maps?q=51.31235,9.48012')
  })

  it('writes a distance in metres up to a kilometre and in kilometres beyond', () => {
    expect(formatDistance(437)).toBe('440 м')
    expect(formatDistance(1840)).toBe('1,8 км')
    expect(formatDistance(48_300)).toBe('48 км')
  })
})

describe('traffic for Germany only', () => {
  it('keeps German towns inside the box and the neighbours\' capitals outside', () => {
    expect(GERMANY_BOUNDS).toHaveLength(4)
    for (const town of [[9.93, 51.53], [13.4, 52.52], [11.58, 48.14], [9.99, 53.55], [6.96, 50.94]] as Coordinate[]) expect(inGermany(town)).toBe(true)
    for (const town of [[2.35, 48.86], [21.01, 52.23], [16.37, 48.21], [4.9, 52.37], [12.57, 55.68]] as Coordinate[]) expect(inGermany(town)).toBe(false)
  })
})
