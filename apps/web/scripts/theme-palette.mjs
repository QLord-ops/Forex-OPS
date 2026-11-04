// Light colours stay exactly as designed; the dark ("Ночная смена") value of every colour is derived here,
// by its role: a background, a text or a line. Run `node scripts/theme-tokens.mjs` after adding a colour.

const hex = (h) => {
  const v = h.replace('#', '')
  const full = v.length === 3 ? [...v].map((c) => c + c).join('') : v.slice(0, 6)
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}
const toHex = (rgb) => '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t)

export const luminance = (rgb) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const contrast = (a, b) => {
  const [x, y] = [luminance(hex(a)), luminance(hex(b))].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

const hsl = ([r, g, b]) => {
  const [R, G, B] = [r / 255, g / 255, b / 255]
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  return [h / 6, s, l]
}
const fromHsl = ([h, s, l]) => {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
  const f = (t) => {
    t = (t + 1) % 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

/** Dark surfaces of "Ночная смена". */
export const DARK = { page: '#08101b', surface: '#0f1a29', raised: '#152236', text: '#e7ecf3' }

// Neutral ramps, keyed by the light colour's lightness. Interpolated between anchors.
const ramp = (anchors) => (l) => {
  const sorted = anchors.map(([k, c]) => [k, hex(c)]).sort((a, b) => a[0] - b[0])
  if (l <= sorted[0][0]) return sorted[0][1]
  for (let i = 1; i < sorted.length; i++) {
    const [k1, c1] = sorted[i - 1], [k2, c2] = sorted[i]
    if (l <= k2) return mix(c1, c2, (l - k1) / (k2 - k1))
  }
  return sorted.at(-1)[1]
}
// Light backgrounds become navy surfaces (white is the card, the grey page is darker than the card);
// dark fills (buttons, the rail) stay dark but lift off the page.
const neutralBg = ramp([[1, DARK.surface], [0.985, '#132235'], [0.965, '#0b1523'], [0.95, '#0c1726'], [0.91, '#1b2a40'], [0.84, '#26364e'], [0.65, '#3a4b64'], [0.47, '#4e5f78'], [0.35, '#2a3b55'], [0.25, '#22324a'], [0.15, '#1a2940'], [0.05, '#0a1220']])
const neutralText = ramp([[1, '#ffffff'], [0.95, '#ffffff'], [0.84, '#4b5a71'], [0.65, '#76839a'], [0.47, '#929eb2'], [0.35, '#aab5c6'], [0.25, '#c9d2de'], [0.1, DARK.text], [0, '#f3f6fa']])
const neutralLine = ramp([[1, '#22324a'], [0.96, '#172538'], [0.91, '#1e2d43'], [0.84, '#2a3a52'], [0.65, '#44546c'], [0.4, '#5b6b83'], [0, '#8b97a9']])

const chroma = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255

/** role: 'bg' | 'tx' | 'ln'. Returns the dark-theme hex for a light-theme hex. */
export function darkOf(lightHex, role) {
  const rgb = hex(lightHex)
  const [h, s, l] = hsl(rgb)
  if (chroma(rgb) < 0.16) {
    return toHex(role === 'bg' ? neutralBg(l) : role === 'tx' ? neutralText(l) : neutralLine(l))
  }
  const hue = fromHsl([h, Math.min(s, 0.75), 0.55])
  const surface = hex(DARK.surface)
  if (role === 'bg') {
    if (l >= 0.93) return toHex(mix(surface, hue, 0.16))
    if (l >= 0.85) return toHex(mix(surface, hue, 0.24))
    if (l >= 0.62) return toHex(mix(surface, hue, 0.42))
    return toHex(rgb) // solid fills keep their colour, their text stays white
  }
  if (role === 'tx') return l < 0.6 ? toHex(fromHsl([h, Math.min(s, 0.85), 0.72])) : toHex(rgb)
  if (l >= 0.75) return toHex(mix(surface, hue, 0.38))
  return l < 0.45 ? toHex(fromHsl([h, s, 0.62])) : toHex(rgb)
}

export const triplet = (h) => hex(h).join(' ')
export const normalize = (h) => toHex(hex(h))

/** Tailwind palettes whose utilities are themed (bg-slate-50, text-red-700 …). */
export const TAILWIND_PALETTES = ['slate', 'red', 'emerald', 'amber', 'sky', 'yellow', 'orange', 'rose']
export const ROLE_OF_PROPERTY = (prop) => {
  if (/^(color|caret-color|fill|stroke|-webkit-text-fill-color)$/.test(prop)) return 'tx'
  if (/^(border|outline|column-rule|text-decoration)/.test(prop)) return 'ln'
  if (/^(background|box-shadow|text-shadow|accent-color)/.test(prop)) return 'bg'
  return null
}
