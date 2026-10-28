import { afterEach, describe, expect, it } from 'vitest';
import { getRoutePreview, previewGeometry, setRoutePreview, subscribeRoutePreview } from '../src/lib/route-preview';

afterEach(() => setRoutePreview(null));
describe('shared route map preview', () => {
  it('accepts scenario tuples and routing provider coordinate objects', () => {
    expect(previewGeometry({ geometry: [[13, 52], [14, 53]] })).toEqual([[13, 52], [14, 53]]);
    expect(previewGeometry({ routes: [{ geometry: [{ longitude: 13, latitude: 52 }, { longitude: 14, latitude: 53 }] }] })).toEqual([[13, 52], [14, 53]]);
    expect(previewGeometry({ after: { geometry: [[13, 52], [14, 53]] } })).toHaveLength(2);
  });
  it('rejects invalid paths and never invents a path from stops', () => {
    for (const value of [null, {}, { geometry: [[13, 52]] }, { geometry: [[13, 52], [NaN, 53]] }, { geometry: [[13, 52], [14, 91]] }, { stops: [{ longitude: 13, latitude: 52 }, { longitude: 14, latitude: 53 }] }]) expect(previewGeometry(value)).toEqual([]);
  });
  it('retains preview across subscription remounts and clears explicitly', () => {
    let calls = 0;
    const off = subscribeRoutePreview(() => { calls++; });
    setRoutePreview({ geometry: [[13, 52], [14, 53]], label: 'test' });
    off();
    expect(getRoutePreview()?.label).toBe('test');
    setRoutePreview(null);
    expect(getRoutePreview()).toBeNull();
    expect(calls).toBe(1);
  });
});
