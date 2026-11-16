import { describe, expect, it } from 'vitest';
import { ImportHealth, summarizeReadStats } from '../src/services/import-stats.js';

describe('the speed card sees refusals and waits (owner, 16.11: «долго и не всегда проходят»)', () => {
  it('counts refused and failed readings and the address lookups since the server started', () => {
    const health = new ImportHealth(new Date('2026-11-16T14:00:00Z'));
    health.readingRefused('queue');
    health.readingRefused('limit');
    health.readingRefused('limit');
    health.readingFailed();
    health.addressLookup(400, 'found');
    health.addressLookup(900, 'found');
    health.addressLookup(3_000, 'busy');
    health.addressLookup(1_200, 'not-found');
    expect(health.summary()).toEqual({ since: '2026-11-16T14:00:00.000Z', readingsFailed: 1, queueFull: 1, limitReached: 2,
      addressLookups: 4, addressFailed: 1, addressBusy: 1, addressMedianMs: 900, addressP90Ms: 3_000 });
  });

  it('shows how long readings waited for a free place', () => {
    const stats = (queueMs?: number) => ({ previewJson: JSON.stringify({ readStats: { model: 'm', effort: 'low', serviceTier: null, readMode: 'text', extractMs: 100, modelMs: 5_000, postMs: 50,
      inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null, settingsRejected: false, ...(queueMs === undefined ? {} : { queueMs }) } }), createdAt: new Date('2026-11-16T14:00:00Z') });
    const summary = summarizeReadStats([stats(0), stats(2_000), stats(8_000), stats()]);
    expect(summary).toMatchObject({ queueMedianMs: 2_000, queueP90Ms: 8_000 });
  });
});
