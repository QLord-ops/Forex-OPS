import { describe, expect, it } from 'vitest';
import { percentile, readStatsOf, summarizeReadStats, totalReadMs } from '../src/services/import-stats.js';
import type { ReadStats } from '../src/services/pdf-order-import.js';

const stats = (extra: Partial<ReadStats> = {}): ReadStats => ({
  model: 'gpt-5.4-mini', effort: 'low', serviceTier: 'default', readMode: 'text', extractMs: 200, modelMs: 6000, postMs: 300,
  inputTokens: 6000, cachedTokens: 3000, outputTokens: 1500, reasoningTokens: 200, settingsRejected: false, contextMs: 100, totalMs: 7000, ...extra
});
const row = (readStats: unknown, minute: number) => ({ previewJson: JSON.stringify({ drafts: [], readStats }), createdAt: new Date(Date.UTC(2026, 10, 9, 8, minute)) });

describe('reading speed of the last Auftrag', () => {
  it('takes the value most readings stayed under, not an average pulled up by one scan', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7000], 0.9)).toBe(7000);
    expect(percentile([9000, 5000, 7000, 6000, 80000], 0.5)).toBe(7000);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((second) => second * 1000), 0.9)).toBe(9000);
  });

  it('sums up median, 90 %, the 10 s promise, cache share and how the files were read', () => {
    const summary = summarizeReadStats([
      row(stats({ totalMs: 6000 }), 1),
      row(stats({ totalMs: 8000, effort: 'none', serviceTier: 'priority' }), 5),
      row(stats({ totalMs: 45000, readMode: 'file', modelMs: 44000, cachedTokens: 0, settingsRejected: true }), 2),
      row(stats({ totalMs: 9000, readMode: 'image', inputTokens: null, cachedTokens: null }), 3),
      { previewJson: JSON.stringify({ drafts: [] }), createdAt: new Date(Date.UTC(2026, 10, 9, 9, 0)) },
      { previewJson: 'not json', createdAt: new Date(Date.UTC(2026, 10, 9, 9, 1)) }
    ], { OPENAI_IMPORT_REASONING_EFFORT: 'none', OPENAI_IMPORT_SERVICE_TIER: 'fast' });
    expect(summary).toMatchObject({
      documents: 6, count: 4, targetMs: 10_000, medianMs: 8000, p90Ms: 45000, modelMedianMs: 6000, withinTarget: 3,
      modes: { text: 2, file: 1, image: 1 }, settingsRejected: 1,
      lastReadAt: '2026-11-09T08:05:00.000Z', last: { model: 'gpt-5.4-mini', effort: 'none', serviceTier: 'priority' },
      configured: { effort: 'none', serviceTier: 'priority' }
    });
    // 6000 cached of 18000 input tokens; the reading without token counts is left out of the share.
    expect(summary.cachedShare).toBeCloseTo(1 / 3);
  });

  it('answers with empty numbers before the first measured reading', () => {
    expect(summarizeReadStats([], {})).toMatchObject({ documents: 0, count: 0, medianMs: null, p90Ms: null, cachedShare: null, last: null, lastReadAt: null, configured: { effort: 'low', serviceTier: null } });
  });

  it('ignores stored numbers that are not numbers and adds the parts up when the total is missing', () => {
    expect(readStatsOf(JSON.stringify({ readStats: { ...stats(), modelMs: 'fast' } }))).toBeNull();
    expect(readStatsOf(JSON.stringify({ readStats: { ...stats(), readMode: 'fax' } }))).toBeNull();
    expect(readStatsOf('null')).toBeNull();
    expect(totalReadMs(stats({ totalMs: undefined }))).toBe(6600);
  });
});
