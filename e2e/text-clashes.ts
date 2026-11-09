import type { Page } from '@playwright/test'

/** Pieces of text that are drawn over each other, and labels that broke onto a second line or were cut. */
export const textClashes = (page: Page, selector: string) => page.locator(selector).evaluate((root) => {
  const textBoxes = (element: Element) => {
    const boxes: Array<{ node: Node; text: string; rect: DOMRect }> = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim()
      const parent = node.parentElement
      if (!text || !parent || parent.closest('.sr-only') || !parent.checkVisibility()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      // Text cut off by a parent («…» or overflow: hidden) is only drawn where the parent shows it.
      let clip: DOMRect | null = null
      for (let element: Element | null = parent; element && element !== document.body; element = element.parentElement) {
        const style = getComputedStyle(element)
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          const box = element.getBoundingClientRect()
          clip = clip ? new DOMRect(Math.max(clip.left, box.left), Math.max(clip.top, box.top),
            Math.min(clip.right, box.right) - Math.max(clip.left, box.left), Math.min(clip.bottom, box.bottom) - Math.max(clip.top, box.top)) : box
        }
      }
      for (const raw of range.getClientRects()) {
        const rect = clip ? new DOMRect(Math.max(raw.left, clip.left), Math.max(raw.top, clip.top),
          Math.min(raw.right, clip.right) - Math.max(raw.left, clip.left), Math.min(raw.bottom, clip.bottom) - Math.max(raw.top, clip.top)) : raw
        if (rect.width > 0 && rect.height > 0) boxes.push({ node, text, rect })
      }
    }
    return boxes
  }
  const boxes = textBoxes(root)
  const clashes: string[] = []
  // Pieces of one text (lines of a wrapped text, a line cut with «…») never count against each other.
  boxes.forEach((a, index) => boxes.slice(index + 1).filter((b) => b.node !== a.node).forEach((b) => {
    const x = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left)
    const y = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top)
    if (x > 1 && y > 1) clashes.push(`«${a.text}» × «${b.text}»`)
  }))
  for (const label of root.querySelectorAll('strong, .status-pill')) {
    const [first, ...rest] = textBoxes(label).map((box) => box.rect)
    // A second line starts below the first one; pieces of one line overlap it in height.
    if (first && rest.some((rect) => rect.top >= first.bottom - 2)) clashes.push(`«${label.textContent}» перенесён на вторую строку`)
    if (label.scrollWidth > label.clientWidth + 1) clashes.push(`«${label.textContent}» обрезан`)
  }
  return clashes
})
