import { describe, expect, it } from 'vitest';
import { berlinClock, courseText, durationBetween, formatDurationMs, formatFuel, formatWholeKm, share, tripsWithParking, workState } from '../src/lib/telemetry-format';

describe('vehicle card formatting', () => {
  it('turns tachograph milliseconds into hours and minutes and flags overruns', () => {
    expect(formatDurationMs(22_980_000)).toBe('6 ч 23 мин');
    expect(formatDurationMs(36_000_000)).toBe('10 ч');
    expect(formatDurationMs(0)).toBe('0 мин');
    expect(formatDurationMs(-900_000)).toBe('превышено на 15 мин');
    expect(formatDurationMs(null)).toBe('–');
    expect(formatDurationMs(175_080_000)).toBe('48 ч 38 мин');
    expect(formatDurationMs(201_600_000)).toBe('56 ч');
  });

  it('names directions and work states without guessing unknown codes', () => {
    expect(courseText(45)).toBe('на северо-восток');
    expect(courseText(359)).toBe('на север');
    expect(courseText(null)).toBe('');
    expect(workState(5)).toEqual({ label: 'За рулём', tone: 'driving' });
    expect(workState(0).label).toBe('Состояние неизвестно');
    expect(workState(42).tone).toBe('unknown');
  });

  it('shows Webfleet clock times in Berlin time and parking between trips', () => {
    const now = new Date('2026-11-03T09:00:00Z');
    expect(berlinClock('2026-11-03T10:06:00Z', now)).toBe('11:06');
    expect(berlinClock('2026-11-08T05:08:00Z', now)).toBe('08.11, 06:08');
    expect(durationBetween('2026-11-03T07:46:00Z', now)).toBe('1 ч 14 мин');
    const rows = tripsWithParking([
      { id: 'a', startAt: '2026-11-03T03:30:00Z', endAt: '2026-11-03T05:44:00Z' },
      { id: 'b', startAt: '2026-11-03T07:16:00Z', endAt: null },
      { id: 'c', startAt: '2026-11-02T18:32:00Z', endAt: '2026-11-02T18:44:00Z' }
    ]);
    expect(rows.map((row) => [row.trip.id, row.parkedMs && formatDurationMs(row.parkedMs)])).toEqual([['b', '1 ч 32 мин'], ['a', '8 ч 46 мин'], ['c', null]]);
  });

  it('formats fuel, odometer and bar shares', () => {
    expect(formatFuel(82.4, 733)).toBe('82 % · ~733 л');
    expect(formatFuel(82.4, null)).toBe('82 %');
    expect(formatWholeKm(196186.7).replace(/\s/g, ' ')).toBe('196 187 км');
    expect(share(22_980_000, 36_000_000)).toBeCloseTo(0.638, 2);
    expect(share(5, 0)).toBe(0);
  });
});
