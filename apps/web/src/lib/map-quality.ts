// Drawing the map costs in proportion to the pixels of its canvas (measured 13.11.2026 on the production build: the page's
// own code and the traffic layer hardly matter). The raster base map has no detail beyond 1 pixel per CSS pixel, so a
// display scaled to 125–200 % only multiplied the work.
export const FULL_PIXEL_RATIO = 1
/** «Лёгкий режим»: half the pixels of the full one; lines and labels a little softer. */
export const LITE_PIXEL_RATIO = 0.7
/** A pan or zoom below this is felt as lag. */
export const SLOW_FPS = 24
/** This many slow gestures in a row switch the light mode on by itself. */
export const SLOW_GESTURES_FOR_LITE = 2
const MIN_FRAMES = 12

export type MapRenderer = 'gpu' | 'software' | 'unknown'
/** `on`/`off` — chosen by the dispatcher and kept; `auto` — full quality until the map proves slow. */
export type LiteChoice = 'on' | 'off' | 'auto'

export function mapPixelRatio(lite: boolean, devicePixelRatio = 1) {
  return Math.min(devicePixelRatio || 1, lite ? LITE_PIXEL_RATIO : FULL_PIXEL_RATIO)
}

/** The browser draws WebGL on the processor when hardware acceleration is off or the graphics driver is blocked. */
export function rendererKind(name: string | null | undefined): MapRenderer {
  if (!name) return 'unknown'
  return /swiftshader|llvmpipe|software|basic render|softpipe|warp/i.test(name) ? 'software' : 'gpu'
}

/** Frames per second of one pan or zoom from the times of its drawn frames; null when it was too short to tell. */
export function gestureFps(frameTimes: number[]): number | null {
  if (frameTimes.length < MIN_FRAMES) return null
  const gaps = frameTimes.slice(1).map((time, index) => time - frameTimes[index]).sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  return median > 0 ? Math.round(1000 / median) : null
}

/** How many slow gestures in a row there are after this one. */
export function slowStreak(previous: number, fps: number | null) {
  if (fps === null) return previous
  return fps < SLOW_FPS ? previous + 1 : 0
}

export function readLiteChoice(stored: string | null): LiteChoice {
  return stored === 'on' || stored === 'off' ? stored : 'auto'
}

/** "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" → "Intel(R) UHD Graphics 630". */
export function rendererLabel(name: string | null | undefined) {
  if (!name) return 'не определена'
  const inner = /^ANGLE \((.*)\)$/.exec(name)?.[1]
  const part = inner ? inner.split(',')[1]?.trim() ?? inner : name
  return part.replace(/\s+(Direct3D|OpenGL|Vulkan|vs_\d).*$/i, '').slice(0, 60)
}
