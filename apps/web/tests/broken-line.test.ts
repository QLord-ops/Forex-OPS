import { expect, it } from 'vitest'

import { toBrokenLine } from '../src/lib/geometry'

it('draws a route in pieces at the breaks and as one line without them', () => {
  const route: Array<[number, number]> = [[7.2, 51.6], [7.7, 51.5], [9.5, 51.3], [9.5, 51.1], [10.3, 50.97]]
  expect(toBrokenLine(route, [2]).geometry).toEqual({ type: 'MultiLineString', coordinates: [route.slice(0, 2), route.slice(2)] })
  expect(toBrokenLine(route, []).geometry).toEqual({ type: 'LineString', coordinates: route })
  expect(toBrokenLine(route.slice(0, 2), [2]).geometry).toEqual({ type: 'LineString', coordinates: route.slice(0, 2) })
})
