import { useLayoutEffect, type RefObject } from 'react'

/** Steps the top bar takes when its sections do not fit: no account name, then no wordmark, then everything in «Меню». */
const STEPS = ['topbar-fit-1', 'topbar-fit-2', 'topbar-fit-3'] as const

/**
 * Text width depends on the system font (Segoe, SF, DejaVu …), so fixed breakpoints overlap on some screens. The bar
 * measures itself instead and takes only as many steps as it needs. All class changes happen before paint.
 */
export function useTopbarFit(ref: RefObject<HTMLElement | null>, contentKey: unknown) {
  useLayoutEffect(() => {
    const header = ref.current
    if (!header) return
    const overflows = () => {
      const nav = header.querySelector<HTMLElement>('.topbar-nav')
      const tools = header.querySelector<HTMLElement>('.topbar-tools')
      if (!nav || !tools || nav.offsetParent === null) return false
      return nav.scrollWidth > nav.clientWidth + 1 || nav.getBoundingClientRect().right > tools.getBoundingClientRect().left
    }
    const fit = () => {
      header.classList.remove(...STEPS)
      for (const step of STEPS) {
        if (!overflows()) return
        header.classList.add(step)
      }
    }
    fit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    observer?.observe(header)
    void document.fonts?.ready.then(fit)
    return () => observer?.disconnect()
  }, [ref, contentKey])
}
