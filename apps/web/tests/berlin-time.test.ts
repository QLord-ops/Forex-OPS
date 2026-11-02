import { describe, expect, it } from 'vitest';
import { berlinLocalToIso, isoToBerlinLocal } from '../src/lib/berlin-time';

describe('Auftrag times are Berlin wall-clock times', () => {
  it('converts winter and summer times and round-trips', () => {
    expect(berlinLocalToIso('2026-11-05T08:00')).toBe('2026-11-05T07:00:00.000Z');
    expect(berlinLocalToIso('2026-07-01T08:00')).toBe('2026-07-01T06:00:00.000Z');
    expect(isoToBerlinLocal('2026-11-05T07:00:00.000Z')).toBe('2026-11-05T08:00');
    expect(isoToBerlinLocal('2026-07-01T06:00:00.000Z')).toBe('2026-07-01T08:00');
  });
  it('handles the daylight-saving change days', () => {
    expect(berlinLocalToIso('2026-03-29T03:30')).toBe('2026-03-29T01:30:00.000Z');
    expect(berlinLocalToIso('2026-10-25T12:00')).toBe('2026-10-25T11:00:00.000Z');
  });
});
