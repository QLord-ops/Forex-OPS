import { describe, expect, it } from 'vitest'

import { splitRouteAtCoordinate } from '../src/lib/geometry'

describe('cached route geometry', () => {
  it('reuses one route and moves the travelled/remaining split with the lightweight position', () => {
    const route: Array<[number, number]> = [[10, 50], [11, 51], [12, 52], [13, 53]]

    expect(splitRouteAtCoordinate(route, [12, 52])).toEqual({
      travelledGeometry: [[10, 50], [11, 51], [12, 52]],
      remainingGeometry: [[12, 52], [13, 53]]
    })
  })

  it('joins the GPS point to the line only when the truck is on the route', () => {
    const route: Array<[number, number]> = [[9.0, 51.0], [9.2, 51.0], [9.4, 51.0]]
    const onRoute = splitRouteAtCoordinate(route, [9.1, 51.001])
    expect(onRoute.travelledGeometry).toEqual([[9.0, 51.0], [9.1, 51.001]])
    expect(onRoute.remainingGeometry).toEqual([[9.1, 51.001], [9.2, 51.0], [9.4, 51.0]])

    // 15 km north of the plan (the truck took the Autobahn instead): the split stays on the line, no straight line to the truck.
    const offRoute = splitRouteAtCoordinate(route, [9.3, 51.135])
    expect(offRoute.travelledGeometry).toEqual([[9.0, 51.0], [9.2, 51.0], [9.3, 51.0]])
    expect(offRoute.remainingGeometry).toEqual([[9.3, 51.0], [9.4, 51.0]])
    expect(JSON.stringify(offRoute)).not.toContain('51.135')
  })

  it('cuts between vertices, not at the nearest vertex', () => {
    const route: Array<[number, number]> = [[9.0, 51.0], [9.4, 51.0]]
    const split = splitRouteAtCoordinate(route, [9.3, 51.02])
    expect(split.travelledGeometry).toEqual([[9.0, 51.0], [9.3, 51.0]])
    expect(split.remainingGeometry[0][0]).toBeCloseTo(9.3, 6)
  })
})
