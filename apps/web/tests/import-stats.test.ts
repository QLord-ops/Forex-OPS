import { describe, expect, it } from 'vitest';
import { readStatsLine, secondsText, speedCard, tokensText, waitedMs } from '../src/lib/import-stats';
import type { ImportSpeedSummary, ReadStats } from '../src/types/domain';

const plain = (text: string | undefined) => (text ?? '').replace(/\u00a0/g, ' ');
const stats = (extra: Partial<ReadStats> = {}): ReadStats => ({
  model: 'gpt-5.4-mini', effort: 'low', serviceTier: 'priority', readMode: 'text', extractMs: 200, modelMs: 6100, postMs: 300,
  inputTokens: 6210, cachedTokens: 3072, outputTokens: 1480, reasoningTokens: 0, settingsRejected: false, contextMs: 100, totalMs: 6700, ...extra
});
const summary = (extra: Partial<ImportSpeedSummary> = {}): ImportSpeedSummary => ({
  documents: 100, count: 40, targetMs: 10_000, medianMs: 7200, p90Ms: 9400, modelMedianMs: 6100, withinTarget: 38, cachedShare: 0.49,
  inputTokensMedian: 6210, outputTokensMedian: 1480, reasoningTokensMedian: 0, modes: { text: 34, file: 4, image: 2 }, settingsRejected: 0,
  lastReadAt: '2026-11-09T08:05:00.000Z', last: { model: 'gpt-5.4-mini', effort: 'low', serviceTier: 'default' }, configured: { effort: 'low', serviceTier: null }, ...extra
});

describe('reading speed texts', () => {
  it('writes seconds the way a dispatcher reads them and groups tokens by thousands', () => {
    expect(plain(secondsText(6100))).toBe('6,1 с');
    expect(plain(secondsText(240))).toBe('0,2 с');
    expect(plain(secondsText(9960))).toBe('10 с');
    expect(plain(secondsText(12_400))).toBe('12 с');
    expect(plain(secondsText(-5))).toBe('0,0 с');
    expect(plain(tokensText(6210))).toBe('6 210');
    expect(plain(tokensText(1_480_000))).toBe('1 480 000');
    expect(tokensText(480)).toBe('480');
    expect(waitedMs(1000, 8400)).toBe(7400);
    expect(waitedMs(1000, 400)).toBe(0);
  });

  it('shows the admin where the time of one reading went', () => {
    expect(plain(readStatsLine(stats()))).toBe('ИИ 6,1 с · текст 0,2 с · проверка 0,4 с · токены: вход 6 210 (кэш 3 072), выход 1 480 · рассуждение low · быстрый режим');
    expect(plain(readStatsLine(stats({ readMode: 'file', extractMs: 0, serviceTier: null, cachedTokens: 0, effort: 'none', totalMs: undefined, contextMs: undefined }))))
      .toBe('ИИ 6,1 с · PDF как файл · проверка 0,3 с · токены: вход 6 210, выход 1 480 · рассуждение none · обычный режим');
    expect(plain(readStatsLine(stats({ readMode: 'image', inputTokens: null, cachedTokens: null, outputTokens: null, serviceTier: 'flex', settingsRejected: true }))))
      .toBe('ИИ 6,1 с · фото · проверка 0,4 с · рассуждение low · экономный режим · настройки скорости отклонены OpenAI');
  });

  it('says in words whether the 10 s promise holds', () => {
    const card = speedCard(summary());
    expect(plain(card?.verdict)).toBe('Медиана 7,2 с, 90 % — до 9,4 с. Цель 10 с выдержана.');
    expect(card?.onTarget).toBe(true);
    expect(card?.rows.map((row) => plain(`${row.label}: ${row.value}`))).toEqual([
      'Уложились в 10 с: 38 из 40 (95 %)',
      'Ответ ИИ (медиана): 6,1 с',
      'Токены на Auftrag (медиана): вход 6 210, выход 1 480',
      'Входные токены из кэша: 49 %',
      'Как читались: текст PDF — 34, PDF как файл — 4, фото — 2',
      'Настройка сервера: рассуждение low, обычный режим'
    ]);
    expect(card?.warning).toBeNull();

    expect(plain(speedCard(summary({ p90Ms: 31_000 }))?.verdict)).toBe('Медиана 7,2 с, 90 % — до 31 с. Обычно быстрее 10 с, но каждый десятый Auftrag дольше.');
    const slow = speedCard(summary({ medianMs: 14_000, p90Ms: 45_000, settingsRejected: 3, cachedShare: null, inputTokensMedian: null, modes: { text: 40, file: 0, image: 0 }, configured: { effort: 'none', serviceTier: 'priority' } }));
    expect(plain(slow?.verdict)).toBe('Медиана 14 с, 90 % — до 45 с. Медленнее цели 10 с.');
    expect(slow?.onTarget).toBe(false);
    expect(slow?.rows.map((row) => plain(row.label))).toEqual(['Уложились в 10 с', 'Ответ ИИ (медиана)', 'Как читались', 'Настройка сервера']);
    expect(slow?.rows.at(-1)?.value).toBe('рассуждение none, быстрый режим');
    expect(slow?.warning).toBe('OpenAI отклонил настройки скорости в 3 из 40 разборов — они прошли с обычными настройками.');
  });

  it('has nothing to show before the first measured reading', () => {
    expect(speedCard(summary({ count: 0, medianMs: null, p90Ms: null }))).toBeNull();
  });
});
