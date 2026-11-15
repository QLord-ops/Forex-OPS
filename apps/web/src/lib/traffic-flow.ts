import type { LayerSpecification } from 'maplibre-gl'

export const TRAFFIC_COLORS = { SLOW: '#f29900', JAM: '#d93025', STANDSTILL: '#8b0000', CLOSED: '#202124' } as const
/** How often the map fetches new traffic tiles. MapLibre's own reload of expired tiles is off: it made the map stutter. */
export const TRAFFIC_REFRESH_MS = 5 * 60_000
/** Closer in, the zoom-12 tiles are scaled up: far fewer tiles to fetch and read while zooming. */
export const TRAFFIC_MAX_TILE_ZOOM = 12

/**
 * Traffic is shown for Germany only (owner, 15.11.2026): tiles outside this box are never fetched. A box, not the border,
 * so strips of the neighbours along it are inside too.
 */
export const GERMANY_BOUNDS: [number, number, number, number] = [5.87, 47.27, 15.04, 55.06]

export function inGermany(coordinate: readonly [number, number]): boolean {
  return coordinate[0] >= GERMANY_BOUNDS[0] && coordinate[0] <= GERMANY_BOUNDS[2] && coordinate[1] >= GERMANY_BOUNDS[1] && coordinate[1] <= GERMANY_BOUNDS[3]
}

/** The refresh slot in the address: the browser fetches new tiles once per slot and reuses them inside it. */
export function trafficTileUrl(key: string, now = Date.now()) {
  return `https://api.tomtom.com/traffic/map/4/tile/flow/relative-delay/{z}/{x}/{y}.pbf?key=${encodeURIComponent(key)}&t=${Math.floor(now / TRAFFIC_REFRESH_MS)}`
}

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
