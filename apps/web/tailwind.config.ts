import type { Config } from 'tailwindcss'
import colors from 'tailwindcss/colors.js'
// @ts-expect-error plain ESM helper shared with scripts/theme-tokens.mjs
import { TAILWIND_PALETTES, normalize } from './scripts/theme-palette.mjs'

type Role = 'bg' | 'tx' | 'ln'
// Same light value as Tailwind's, through the theme variable of its role (see src/theme-tokens.css).
const themed = (role: Role) => Object.fromEntries((TAILWIND_PALETTES as string[]).map((palette) => [
  palette,
  Object.fromEntries(Object.entries((colors as unknown as Record<string, Record<string, string>>)[palette]).map(([step, value]) => [
    step,
    `rgb(var(--${role}-${(normalize(value) as string).slice(1)}) / <alpha-value>)`
  ]))
]))

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: { ...themed('bg'), white: 'rgb(var(--bg-ffffff) / <alpha-value>)', acc: 'var(--acc)', 'acc-ink': 'var(--acc-ink)' },
      textColor: { ...themed('tx'), white: '#fff' },
      borderColor: { ...themed('ln'), white: 'rgb(var(--ln-ffffff) / <alpha-value>)' },
      divideColor: themed('ln'),
      placeholderColor: themed('tx'),
      fontVariantNumeric: {
        tabular: 'tabular-nums'
      }
    }
  },
  plugins: []
} satisfies Config
