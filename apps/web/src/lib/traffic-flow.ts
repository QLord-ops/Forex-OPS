import type { LayerSpecification } from 'maplibre-gl'

export const TRAFFIC_COLORS = { SLOW: '#f29900', JAM: '#d93025', STANDSTILL: '#8b0000', CLOSED: '#202124' } as const

const LEVEL = ['coalesce', ['get', 'traffic_level'], 1]
const ONE_SIDE = ['==', ['get', 'traffic_road_coverage'], 'one_side']

/**
 * Traffic on the whole map, as Webfleet draws it: only the slow stretches, coloured along the road and thick enough to see
 * at country zoom. TomTom vector flow tiles: `traffic_level` is the share of free-flow speed — below 0.7 slow,
 * below 0.4 a jam, below 0.15 standing.
 */
export function trafficFlowLayer(opacity: number): LayerSpecification {
  return {
    id: 'traffic-flow',
    type: 'line',
    source: 'traffic',
    'source-layer': 'Traffic flow',
    filter: ['any', ['has', 'road_closure'], ['<', LEVEL, 0.7]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['case', ['has', 'road_closure'], TRAFFIC_COLORS.CLOSED,
        ['step', LEVEL, TRAFFIC_COLORS.STANDSTILL, 0.15, TRAFFIC_COLORS.JAM, 0.4, TRAFFIC_COLORS.SLOW]],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 8, 3.5, 12, 5, 16, 8],
      // A two-way road reports each direction on its own: shift it to its side so both directions stay visible.
      'line-offset': ['interpolate', ['linear'], ['zoom'], 5, ['case', ONE_SIDE, 1.5, 0], 16, ['case', ONE_SIDE, 5, 0]],
      'line-opacity': opacity
    }
  } as unknown as LayerSpecification
}
