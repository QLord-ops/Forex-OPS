import { describe, expect, it, vi } from 'vitest';
import { importPdfPreview, nothingRead } from '../src/services/pdf-order-import.js';
import { hasTextLayer, readableShare, type PdfText } from '../src/services/pdf-text.js';

// Owner, 17.11.2026: an mRoad Deckblatt (Werk 065 Düsseldorf, GÖ-FX131, 18.11 12:00–12:30) came back as an Auftrag
// with two empty stops and the model's own note «Текст PDF сильно искажён». Its text layer was symbols, not words.
const page = (text: string): PdfText => ({ pages: [text], chars: text.replace(/\s+/g, '').length });
const readable = page('Deckblatt zur Warenanlieferung\nWerk 065, Düsseldorf   Borderonummer 15015296\nAnlieferdatum 18.11.2026   LKW-Kennzeichen GÖ-FX131   Von: 12:00 Bis: 12:30\nSpediteur 17848466 Schnellecke Transportlogistik');
const symbols = page('\u0003\u0012\u0015\u0011 ‡†§¶  ■□▪▫ '.repeat(12));

const blank = { documentType: null, plate: null, trailerPlate: null, company: null, site: null, city: null, stopType: null, appointmentLocal: null, windowStartLocal: null,
  windowEndLocal: null, appointmentDateLocal: null, standgeldFromLocal: null, references: [], positions: [], sourceExcerpt: null, confidence: 0.9 };
const emptyStop = (sequence: number, type: 'LOAD' | 'UNLOAD') => ({ sequence, type, company: null, address: null, city: null, appointmentLocal: null, appointmentWindowStartLocal: null,
  appointmentWindowEndLocal: null, appointmentDateLocal: null, loadingMeters: null, referenceNumbers: [], instructions: null, sourcePage: 1, sourceExcerpt: null, confidence: 0.3 });
const emptyOrder = { documentKind: 'ORDER', appointment: null, warnings: [], drafts: [{ orderNumber: null, vehicleNumber: null, vehiclePlate: null, trailerPlate: null, tourRemarks: null,
  tourRemarksSourcePage: null, departmentCompany: null, departmentAddress: null, departmentCity: null, departmentSourcePage: null, warnings: [], stops: [emptyStop(1, 'LOAD'), emptyStop(2, 'UNLOAD')] }] };
const deckblatt = { documentKind: 'APPOINTMENT', drafts: [], warnings: [], appointment: { ...blank, documentType: 'Deckblatt zur Warenanlieferung', plate: 'GÖ-FX131', company: 'Werk 065',
  site: 'Werk 065', city: 'Düsseldorf', stopType: 'UNLOAD', windowStartLocal: '2026-11-18T12:00', windowEndLocal: '2026-11-18T12:30' } };

type Body = { input: [unknown, { content: Array<{ type: string }> }] };
const model = (...answers: unknown[]) => {
  const asked: Body[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    asked.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ output_text: JSON.stringify(answers.shift()) }), { status: 200 });
  });
  return { fetchImpl, asked, parts: (index: number) => asked[index].input[1].content.map((part) => part.type) };
};
const read = (pdfText: PdfText, fetchImpl: unknown) =>
  importPdfPreview(Buffer.from('%PDF-1.7'), 'DB Düsse 18.11.pdf', { apiKey: 'test', model: 'gpt-test', fetchImpl: fetchImpl as typeof fetch, pdfText, now: new Date('2026-11-17T10:00:00Z') });

describe('a text layer of symbols is no text', () => {
  it('tells words from symbols', () => {
    expect(readableShare(readable)).toBeGreaterThan(0.95);
    expect(hasTextLayer(readable)).toBe(true);
    expect(readableShare(symbols)).toBeLessThan(0.2);
    expect(hasTextLayer(symbols)).toBe(false);
  });

  it('reads such a PDF from its page at once', async () => {
    const { fetchImpl, parts } = model(deckblatt);
    const preview = await read(symbols, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parts(0)).toEqual(['input_file', 'input_text']);
    expect(preview).toMatchObject({ documentKind: 'APPOINTMENT', readMode: 'file' });
  });
});

describe('a text reading that understood nothing is read again from the pages', () => {
  it('turns two empty stops into the Termin slip the page shows', async () => {
    const { fetchImpl, parts } = model(emptyOrder, deckblatt);
    const preview = await read(page(`${readable.pages[0].replace(/Deckblatt zur Warenanlieferung\n/, '')}\nFabrikat Mercedes Benz`), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(parts(0)).toEqual(['input_text', 'input_text']);
    expect(parts(1)).toEqual(['input_file', 'input_text']);
    expect(preview).toMatchObject({ documentKind: 'APPOINTMENT', readMode: 'file', appointment: { plate: 'GÖ-FX131', city: 'Düsseldorf' } });
    expect(preview.readStats?.fromPagesAfterText).toBe(true);
  });

  it('keeps a text reading that found something', () => {
    expect(nothingRead({ documentKind: 'ORDER', drafts: [{ orderNumber: null, vehicleNumber: null, warnings: [], stops: [{ ...emptyStop(1, 'LOAD'), city: 'Düsseldorf' }] }] })).toBe(false);
    expect(nothingRead({ documentKind: 'APPOINTMENT', drafts: [] })).toBe(false);
    expect(nothingRead({ documentKind: 'ORDER', drafts: [] })).toBe(true);
  });
});
