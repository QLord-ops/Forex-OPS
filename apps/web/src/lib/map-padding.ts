export type Padding = number | { top: number; right: number; bottom: number; left: number }

/**
 * Where one point (a truck, a stop) is shown: the middle of what the list, the truck card and the panels leave free.
 * Returns the shift of the map centre in pixels; none on an axis where the paddings leave no room at all.
 */
export function centreOffset(padding: Padding, width: number, height: number): [number, number] {
  if (typeof padding === 'number') return [0, 0]
  const x = width - padding.left - padding.right >= 80 ? (padding.left - padding.right) / 2 : 0
  const y = height - padding.top - padding.bottom >= 80 ? (padding.top - padding.bottom) / 2 : 0
  return [Math.round(x), Math.round(y)]
}
