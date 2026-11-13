import { describe, expect, it } from 'vitest'

import { gestureFps, LITE_PIXEL_RATIO, mapPixelRatio, readLiteChoice, rendererKind, rendererLabel, slowStreak, SLOW_GESTURES_FOR_LITE } from '../src/lib/map-quality'

const frames = (gapMs: number, count = 30) => Array.from({ length: count }, (_, index) => index * gapMs)

describe('map quality', () => {
  it('never draws more than one pixel per CSS pixel, and fewer in the light mode', () => {
    expect(mapPixelRatio(false, 1.5)).toBe(1)
    expect(mapPixelRatio(false, 2)).toBe(1)
    expect(mapPixelRatio(false, 1)).toBe(1)
    expect(mapPixelRatio(true, 1.25)).toBe(LITE_PIXEL_RATIO)
    expect(mapPixelRatio(false, 0.5)).toBe(0.5)
  })

  it('tells drawing on the processor from a graphics card', () => {
    expect(rendererKind('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe('software')
    expect(rendererKind('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('software')
    expect(rendererKind('ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('gpu')
    expect(rendererKind(null)).toBe('unknown')
    expect(rendererLabel('ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('Intel(R) UHD Graphics 630')
    expect(rendererLabel(null)).toBe('не определена')
  })

  it('measures a gesture by its median frame and ignores a short one', () => {
    expect(gestureFps(frames(16.7))).toBe(60)
    expect(gestureFps(frames(50))).toBe(20)
    expect(gestureFps([...frames(16.7, 29), 2000])).toBe(60)
    expect(gestureFps(frames(50, 5))).toBeNull()
  })

  it('counts slow gestures in a row; a smooth one starts over, a short one changes nothing', () => {
    let streak = 0
    streak = slowStreak(streak, 18)
    streak = slowStreak(streak, null)
    expect(streak).toBe(1)
    streak = slowStreak(streak, 20)
    expect(streak).toBe(SLOW_GESTURES_FOR_LITE)
    expect(slowStreak(streak, 45)).toBe(0)
  })

  it('keeps the dispatcher\'s own choice of the light mode', () => {
    expect(readLiteChoice('on')).toBe('on')
    expect(readLiteChoice('off')).toBe('off')
    expect(readLiteChoice(null)).toBe('auto')
    expect(readLiteChoice('1')).toBe('auto')
  })
})
