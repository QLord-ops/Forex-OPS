import { describe, expect, it, vi } from 'vitest';
import { importPdfPreview, ModelAnswerError } from '../src/services/pdf-order-import.js';

// Owner, 17.11.2026: an Auftrag failed with «Сервер временно недоступен» and read in 10 s after a reload. The model had
// run on in blank lines inside its JSON (12 830 lines in 17 000 characters) until the token limit cut it off.
const stop = (sequence: number, type: 'LOAD' | 'UNLOAD') => ({
  sequence, type, company: type === 'LOAD' ? 'Werk Göttingen' : 'Audi AG', address: type === 'LOAD' ? 'Otto-Brenner-Str. 20, 37079 Göttingen' : 'Auto-Union-Str. 1, 85057 Ingolstadt',
  city: null, appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null, appointmentDateLocal: null,
  loadingMeters: null, referenceNumbers: [], instructions: null, sourcePage: 1, sourceExcerpt: null, confidence: 0.9
});
const good = JSON.stringify({ drafts: [{
  orderNumber: 'A-1', vehicleNumber: null, vehiclePlate: null, trailerPlate: null, tourRemarks: 'Göttingen für Audi Ingolstadt', tourRemarksSourcePage: 1,
  departmentCompany: null, departmentAddress: null, departmentCity: null, departmentSourcePage: null, stops: [stop(1, 'LOAD'), stop(2, 'UNLOAD')], warnings: [] }], warnings: [] });
const cutOff = `${good.slice(0, 400)}${'\n'.repeat(12_000)}`;

const answers = (...bodies: Array<{ output_text: string; status?: string }>) => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(bodies.shift() ?? bodies.at(-1)), { status: 200 }));
  return fetchImpl;
};
const read = (fetchImpl: ReturnType<typeof answers>) =>
  importPdfPreview(Buffer.from('%PDF-1.7'), 'auftrag.pdf', { apiKey: 'test', model: 'gpt-test', fetchImpl: fetchImpl as unknown as typeof fetch, pdfText: null });

describe('a broken answer of the model is asked once more at once', () => {
  it('reads the Auftrag when the first answer was cut off by the token limit', async () => {
    const fetchImpl = answers({ output_text: cutOff, status: 'incomplete' }, { output_text: good, status: 'completed' });
    const preview = await read(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(preview.drafts[0].orderNumber).toBe('A-1');
    expect(preview.readStats?.retried).toBe('INCOMPLETE');
  });

  it('asks again when a «completed» answer is no JSON', async () => {
    const fetchImpl = answers({ output_text: cutOff, status: 'completed' }, { output_text: good });
    const preview = await read(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(preview.readStats?.retried).toBe('BROKEN_JSON');
  });

  it('gives up after the second broken answer, with its own error and no third ask', async () => {
    const fetchImpl = answers({ output_text: cutOff, status: 'incomplete' }, { output_text: cutOff, status: 'incomplete' }, { output_text: good });
    await expect(read(fetchImpl)).rejects.toBeInstanceOf(ModelAnswerError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('asks once when the answer is fine', async () => {
    const fetchImpl = answers({ output_text: good, status: 'completed' });
    const preview = await read(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(preview.readStats?.retried).toBeNull();
  });
});
