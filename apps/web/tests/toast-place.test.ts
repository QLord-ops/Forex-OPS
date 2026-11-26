import { describe, expect, it } from 'vitest'
import { toastPlace } from '../src/lib/toast-place'

const box = (left: number, right: number, top: number, bottom: number) => ({ left, right, bottom, height: bottom - top })

describe('toast below the map buttons (owner, 26.11)', () => {
  it('comes up right under «Адрес / Маршрут / Auftrag», aligned with their right edge', () => {
    expect(toastPlace(box(1500, 1880, 120, 160), null, 1920)).toEqual({ top: 168, right: 40 })
  })

  it('moves beside an opened panel so the drop zone stays free', () => {
    expect(toastPlace(box(1500, 1880, 120, 160), box(1480, 1880, 168, 700), 1920)).toEqual({ top: 168, right: 448 })
  })

  it('stays under the buttons when there is no room beside the panel', () => {
    expect(toastPlace(box(700, 1000, 120, 160), box(400, 1000, 168, 700), 1024)).toEqual({ top: 168, right: 24 })
  })

  it('takes the corner when the page has no map buttons or they scrolled away', () => {
    expect(toastPlace(null, null, 1920)).toBeNull()
    expect(toastPlace(box(1500, 1880, -80, -40), null, 1920)).toBeNull()
  })
})
