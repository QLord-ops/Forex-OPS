import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM helper shared with the token generator
import { DARK, contrast, darkOf } from '../scripts/theme-palette.mjs'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const tokens = read('src/theme-tokens.css')

describe('theme tokens', () => {
  it('defines every colour variable the styles use, in both themes', () => {
    const [light, dark] = tokens.split('[data-theme="dark"]')
    for (const file of ['src/styles.css', 'src/components/truck-card.css', 'src/components/dispatcher-assistant.css']) {
      for (const [, name] of read(file).matchAll(/var\(--((?:bg|tx|ln)-[0-9a-f]{6})\)/g)) {
        expect(light, `${name} in ${file}`).toContain(`--${name}:`)
        expect(dark, `${name} in ${file}`).toContain(`--${name}:`)
      }
    }
  })

  it('keeps the night text readable (WCAG AA 4.5:1) on the night surfaces', () => {
    const texts = ['#0f172a', '#334155', '#475569', '#64748b', '#b91c1c', '#047857', '#b45309', '#0369a1', '#4338ca', '#0f766e']
    for (const text of texts) {
      for (const surface of [DARK.surface, DARK.page]) {
        expect(contrast(darkOf(text, 'tx'), surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps the light values exactly as designed', () => {
    expect(tokens).toMatch(/:root, \[data-theme="light"\] \{[^}]*--tx-0f172a: 15 23 42;/)
    expect(tokens).toMatch(/:root, \[data-theme="light"\] \{[^}]*--bg-ffffff: 255 255 255;/)
  })

  it('makes light backgrounds dark at night', () => {
    expect(darkOf('#ffffff', 'bg')).toBe(DARK.surface)
    expect(contrast(darkOf('#fef2f2', 'bg'), '#ffffff')).toBeGreaterThan(10)
  })
})
