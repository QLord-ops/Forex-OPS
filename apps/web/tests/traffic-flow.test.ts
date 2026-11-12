import { describe, expect, it } from 'vitest'
import { createExpression, featureFilter, validateStyleMin, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec'

import { TRAFFIC_COLORS, trafficFlowLayer } from '../src/lib/traffic-flow'

const layer = trafficFlowLayer(0.9) as Extract<ReturnType<typeof trafficFlowLayer>, { type: 'line' }>
const feature = (properties: Record<string, unknown>) => ({ type: 2 as const, properties, geometry: [] })

describe('traffic on the whole map', () => {
  it('is a valid MapLibre layer over TomTom vector flow tiles', () => {
    const style: StyleSpecification = { version: 8, sources: { traffic: { type: 'vector', tiles: ['https://example.test/{z}/{x}/{y}.pbf'] } }, layers: [layer] }
    expect(validateStyleMin(style)).toEqual([])
  })

  it('draws only slow, jammed and closed stretches', () => {
    const filter = featureFilter(layer.filter, 'layers[0].filter')
    const shown = (properties: Record<string, unknown>) => filter.filter({ zoom: 7 }, feature(properties))
    expect(shown({ traffic_level: 0.95 })).toBe(false)
    expect(shown({ traffic_level: 0.6 })).toBe(true)
    expect(shown({ traffic_level: 0.05 })).toBe(true)
    expect(shown({ traffic_level: 1, road_closure: true })).toBe(true)
    expect(shown({})).toBe(false)
  })

  it('colours by how slow the road is', () => {
    const color = createExpression(layer.paint?.['line-color'], 'layers[0].paint.line-color')
    if (color.result !== 'success') throw new Error('bad colour expression')
    const at = (properties: Record<string, unknown>) => String(color.value.evaluate({ zoom: 7 }, feature(properties)))
    const rgba = (hex: string) => {
      const parsed = createExpression(hex, 'layers[0].paint.line-color')
      return parsed.result === 'success' ? String(parsed.value.evaluate({ zoom: 7 })) : hex
    }
    expect(rgba(TRAFFIC_COLORS.SLOW)).not.toBe(rgba(TRAFFIC_COLORS.JAM))
    expect(at({ traffic_level: 0.6 })).toBe(rgba(TRAFFIC_COLORS.SLOW))
    expect(at({ traffic_level: 0.3 })).toBe(rgba(TRAFFIC_COLORS.JAM))
    expect(at({ traffic_level: 0.05 })).toBe(rgba(TRAFFIC_COLORS.STANDSTILL))
    expect(at({ traffic_level: 0.9, road_closure: true })).toBe(rgba(TRAFFIC_COLORS.CLOSED))
  })
})
