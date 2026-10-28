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
})
