const TOAST_GAP = 8
const TOAST_WIDTH = 440

type Box = Pick<DOMRect, 'left' | 'right' | 'bottom' | 'height'>

/** The toast must not cover the map's «Адрес / Маршрут / Auftrag» buttons (owner, 26.11): it comes up right under them, and beside an opened panel. */
export function toastPlace(bar: Box | null, panel: Box | null, viewportWidth: number): { top: number; right: number } | null {
  if (!bar || bar.height === 0 || bar.bottom <= 0) return null
  const top = Math.round(bar.bottom + TOAST_GAP)
  if (panel && panel.height > 0 && panel.left - TOAST_GAP * 2 >= TOAST_WIDTH) return { top, right: Math.round(viewportWidth - panel.left + TOAST_GAP) }
  return { top, right: Math.max(16, Math.round(viewportWidth - bar.right)) }
}
