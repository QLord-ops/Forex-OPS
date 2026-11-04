import { describe, expect, it } from 'vitest'

import { roadShieldLabel, roadShields, visibleShields } from '../src/lib/road-shields'
import type { Coordinate } from '../src/types/domain'

// ~1.1 km per step along a meridian: 301 points ≈ 333 km, Göttingen → Würzburg in length.
const route: Coordinate[] = Array.from({ length: 301 }, (_, index) => [9.9, 51.5 - index * 0.01])

describe('road shields on the route', () => {
  it('puts a shield on every Autobahn stretch ahead, more on long ones, and skips short stubs and other roads', () => {
    const shields = roadShields(route, [
      { from: 0, to: 1, road: 'A38' },
      { from: 1, to: 200, road: 'A7' },
      { from: 200, to: 230, road: 'B19' },
      { from: 230, to: 300, road: 'L2310' }
    ])
    expect(shields.map((shield) => shield.road)).toEqual(['A7', 'A7', 'B19'])
    expect(shields.map((shield) => shield.kind)).toEqual(['A', 'A', 'B'])
    expect(shields.map((shield) => shield.priority)).toEqual([0, 1, 2])
    // The two A7 shields sit at a quarter and three quarters of the stretch.
    expect(shields[0].coordinate[1]).toBeCloseTo(51.5 - 0.01 * (1 + 199 / 4), 2)
    expect(shields[1].coordinate[1]).toBeCloseTo(51.5 - 0.01 * (1 + 199 * 3 / 4), 2)
  })

  it('shows only what is ahead of the truck', () => {
    const shields = roadShields(route, [{ from: 0, to: 100, road: 'A7' }, { from: 100, to: 300, road: 'A3' }], { startIndex: 120 })
    expect(shields.map((shield) => shield.road)).toEqual(['A3', 'A3'])
    expect(shields.every((shield) => shield.coordinate[1] < 51.5 - 1.2)).toBe(true)
  })

  it('returns nothing without road data', () => {
    expect(roadShields(route, undefined)).toEqual([])
    expect(roadShields([[9.9, 51.5]], [{ from: 0, to: 1, road: 'A7' }])).toEqual([])
  })

  it('names the shield for screen readers', () => {
    expect(roadShieldLabel({ kind: 'A', road: 'A7' })).toBe('Автобан A7')
    expect(roadShieldLabel({ kind: 'B', road: 'B3' })).toBe('Бундесштрассе B3')
  })

  it('hides shields that would cover a jam icon or a more important shield', () => {
    const box = (left: number, top: number) => ({ left, top, right: left + 30, bottom: top + 20 })
    const visible = visibleShields(
      [{ id: 'a7', box: box(0, 0) }, { id: 'a7-near', box: box(20, 10) }, { id: 'b3', box: box(200, 0) }, { id: 'a3', box: box(400, 0) }],
      [box(210, 5)]
    )
    expect([...visible]).toEqual(['a7', 'a3'])
  })
})
