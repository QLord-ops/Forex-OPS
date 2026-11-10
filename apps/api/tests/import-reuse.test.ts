import { describe, expect, it, vi } from 'vitest';
import { finishModelAnswer, importPdfPreview, importPromptVersion, storedModelAnswerOf, type LearnedImportRules } from '../src/services/pdf-order-import.js';

const stop = (sequence: number, type: 'LOAD' | 'UNLOAD', extra: Record<string, unknown> = {}) => ({
  sequence, type, company: type === 'LOAD' ? 'Werk Göttingen' : 'Audi AG', address: type === 'LOAD' ? 'Otto-Brenner-Str. 20, 37079 Göttingen' : 'Auto-Union-Str. 1, 85057 Ingolstadt',
  city: null, appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null, appointmentDateLocal: null,
  loadingMeters: null, referenceNumbers: [], instructions: null, sourcePage: 1, sourceExcerpt: null, confidence: 0.9, ...extra
});
const answerOf = (stops: unknown[]) => ({ drafts: [{
  orderNumber: 'A-1', vehicleNumber: null, vehiclePlate: null, trailerPlate: null, tourRemarks: 'Göttingen für Audi Ingolstadt', tourRemarksSourcePage: 1,
  departmentCompany: null, departmentAddress: null, departmentCity: null, departmentSourcePage: null, stops, warnings: [] }], warnings: [] });

type Request = { prompt_cache_key?: string; input: [{ role: string; content: string }, { role: string; content: Array<{ type: string; text?: string }> }] };

async function read(options: { now: string; learned?: LearnedImportRules | null; stops?: unknown[] }) {
  let request: Request | null = null;
  const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    request = JSON.parse(String(init?.body)) as Request;
    return new Response(JSON.stringify({ output_text: JSON.stringify(answerOf(options.stops ?? [stop(1, 'LOAD'), stop(2, 'UNLOAD')])) }), { status: 200 });
  });
  const preview = await importPdfPreview(Buffer.from('%PDF-1.7'), 'auftrag.pdf', { apiKey: 'test', model: 'gpt-test', fetchImpl: fetchMock as typeof fetch, now: new Date(options.now), learned: options.learned, pdfText: null });
  return { preview, request: request! as Request };
}

describe('the start of the request is the same for every Auftrag, so OpenAI can cache it', () => {
  it('keeps the date and the learned rules out of the rules and puts them after the document', async () => {
    const monday = await read({ now: '2026-11-02T10:00:00Z' });
    const friday = await read({ now: '2026-11-06T10:00:00Z', learned: { rulesText: 'SZ means Salzgitter.', examplesText: 'Lager für VW SZ' } as LearnedImportRules });

    expect(monday.request.input[0].role).toBe('system');
    expect(friday.request.input[0].content).toBe(monday.request.input[0].content);
    expect(monday.request.input[0].content).not.toMatch(/2026-11-0\d/);
    expect(friday.request.input[0].content).not.toContain('Salzgitter.');
    expect(friday.request.prompt_cache_key).toBe(monday.request.prompt_cache_key);
    expect(monday.request.prompt_cache_key).toMatch(/^ops-auftrag-[0-9a-f]{16}$/);

    // The document comes first in the user message, what changes follows it.
    expect(monday.request.input[1].content[0].type).toBe('input_file');
    const context = friday.request.input[1].content[1].text ?? '';
    expect(context).toContain('today is 2026-11-06');
    expect(context).toContain('SZ means Salzgitter.');
    expect(monday.request.input[1].content[1].text).toContain('today is 2026-11-02');
  });
});

describe('the model answer is kept apart from what the server makes of it', () => {
  it('works the stored answer out again to the same preview without asking the model', async () => {
    const { preview } = await read({ now: '2026-11-02T10:00:00Z' });
    const stored = storedModelAnswerOf(JSON.parse(JSON.stringify(preview.modelAnswer)));
    expect(stored).toMatchObject({ v: 1, model: 'gpt-test', layout: 'PDF', readMode: 'file', readAt: '2026-11-02T10:00:00.000Z' });
    expect(stored!.promptVersion).toBe(importPromptVersion('PDF', null, 'gpt-test'));
    expect(importPromptVersion('PDF', null, 'gpt-other')).not.toBe(stored!.promptVersion);
    expect(importPromptVersion('IMAGE', null, 'gpt-test')).not.toBe(stored!.promptVersion);

    const again = finishModelAnswer(stored!.answer, { layout: stored!.layout, readMode: stored!.readMode });
    const { modelAnswer: _answer, readStats: _stats, ...first } = preview;
    expect(again).toEqual(first);
    expect(again).not.toHaveProperty('modelAnswer');
    expect(storedModelAnswerOf({ v: 2 })).toBeNull();
    expect(storedModelAnswerOf(null)).toBeNull();
  });

  it('cuts a text the model wrote longer than asked instead of losing the reading', async () => {
    const { preview } = await read({ now: '2026-11-02T10:00:00Z', stops: [stop(1, 'LOAD', { sourceExcerpt: 'x'.repeat(400), instructions: 'y'.repeat(1200) }), stop(2, 'UNLOAD')] });
    const first = preview.drafts[0].stops[0] as { sourceExcerpt: string | null; instructions: string | null };
    expect(first.sourceExcerpt).toHaveLength(240);
    expect(first.instructions).toHaveLength(800);
  });
});
