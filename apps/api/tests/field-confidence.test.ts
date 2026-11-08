import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { CustomerService } from '../src/services/customers.js';
import { addressShape, calibrate, correctionRates, fieldOutcomes, levelOf, scoreDraft, supported } from '../src/services/field-confidence.js';
import { importPdfPreview } from '../src/services/pdf-order-import.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

const context = { ai: true, today: '2026-11-08' };
const ai = (c: number, evidence: string | null = null) => ({ c, evidence });
const stop = (extra: Record<string, unknown> = {}) => ({
  type: 'LOAD' as const, company: 'Hydro Aluminium', address: 'Robert-Koch-Str. 4, 08451 Crimmitschau', city: 'Crimmitschau',
  appointmentLocal: '2026-11-10T08:00', loadingMeters: 13.6, referenceNumbers: ['477339'], confidence: 0.9,
  sourceExcerpt: 'Hydro Aluminium, Robert-Koch-Str. 4, 08451 Crimmitschau, 10.11. 08:00 Uhr, LM 13,6, Ref 477339',
  aiConfidence: { type: ai(0.95), company: ai(0.95), address: ai(0.95), city: ai(0.95), time: ai(0.9, '10.11. 08:00 Uhr 2026-11-10T08:00'), loadingMeters: ai(0.9, 'LM 13,6'), references: ai(0.9, 'Ref 477339') },
  ...extra
});
const draft = (stops: Array<ReturnType<typeof stop>>, extra: Record<string, unknown> = {}) => ({
  orderNumber: '71123727', vehicleNumber: '936', vehiclePlate: null, trailerPlate: null, tourRemarks: 'Hydro Crimmitschau für VW Braunschweig',
  orderAiConfidence: { orderNumber: ai(0.97, 'Auftrag 71123727'), vehicle: ai(0.9, 'LKW 936') }, stops, warnings: [] as Array<{ code: string; message: string; stopIndex?: number; field?: string }>, ...extra
});

describe('levels and helpers', () => {
  it('splits scores at 0.85 and 0.6', () => {
    expect([levelOf(0.85), levelOf(0.84), levelOf(0.6), levelOf(0.59)]).toEqual(['OK', 'CHECK', 'CHECK', 'DOUBT']);
  });
  it('knows a full address and a value shown by its quote', () => {
    expect(addressShape('Robert-Koch-Str. 4, 08451 Crimmitschau')).toEqual({ houseNumber: true, postcode: true });
    expect(addressShape('Bremen')).toEqual({ houseNumber: false, postcode: false });
    expect(addressShape('Dieselstraße 2, Barsinghausen')).toEqual({ houseNumber: true, postcode: false });
    expect(addressShape('ul. Fabryczna 5, 44-100 Gliwice').postcode).toBe(true);
    expect(supported('Mercedes-Benz AG', ['Absender: Mercedes-Benz AG Werk 065'])).toBe(true);
    expect(supported('Volkswagen AG', ['Absender: Hydro Aluminium'])).toBe(false);
    expect(supported('BLG', [null, ''])).toBe(false);
  });
});

describe('scoring a recognised Auftrag', () => {
  it('keeps clearly printed fields fine and drops the raw AI answer', () => {
    const scored = scoreDraft(draft([stop()]), context);
    const fields = scored.stops[0].fieldConfidence;
    expect(Object.values(fields).every((field) => field!.level === 'OK')).toBe(true);
    expect(fields.time).toMatchObject({ score: 0.9, evidence: '10.11. 08:00 Uhr 2026-11-10T08:00' });
    expect('aiConfidence' in scored.stops[0]).toBe(false);
    expect(scored.orderConfidence.orderNumber).toMatchObject({ level: 'OK' });
    expect(scored.orderConfidence.trailer).toBeUndefined();
    expect(scored.confidenceSummary).toEqual({ doubt: 0, check: 0 });
  });

  it('marks a value nothing printed shows, but trusts Excel cells', () => {
    const unsupported = stop({ company: 'Volkswagen AG', sourceExcerpt: 'Robert-Koch-Str. 4, 08451 Crimmitschau' });
    expect(scoreDraft(draft([unsupported]), context).stops[0].fieldConfidence.company).toMatchObject({ score: 0.6, level: 'CHECK', reasons: ['NO_EVIDENCE'] });
    expect(scoreDraft(draft([unsupported]), { ...context, ai: false }).stops[0].fieldConfidence.company).toMatchObject({ level: 'OK' });
  });

  it('doubts a city-only address, a missing postcode, a past date and a missing address', () => {
    const fields = (extra: Record<string, unknown>) => scoreDraft(draft([stop(extra)]), context).stops[0].fieldConfidence;
    expect(fields({ address: 'Crimmitschau', sourceExcerpt: 'Crimmitschau' }).address).toMatchObject({ score: 0.5, level: 'DOUBT', reasons: ['ADDRESS_NO_HOUSE_NUMBER'] });
    expect(fields({ address: 'Robert-Koch-Str. 4, Crimmitschau' }).address).toMatchObject({ score: 0.7, level: 'CHECK', reasons: ['ADDRESS_NO_POSTCODE'] });
    expect(fields({ appointmentLocal: '2026-11-01T08:00', aiConfidence: { time: ai(0.9, '01.11. 08:00 2026-11-01T08:00') } }).time).toMatchObject({ score: 0.3, reasons: ['DATE_PAST'] });
    expect(fields({ address: null }).address).toMatchObject({ level: 'DOUBT', reasons: ['MISSING'] });
    expect(fields({ loadingMeters: null, referenceNumbers: [] })).not.toHaveProperty('loadingMeters');
  });

  it('follows where the stop came from', () => {
    const fields = (extra: Record<string, unknown>) => scoreDraft(draft([stop({ aiConfidence: null, confidence: 0.4, ...extra })]), { ...context, ai: false }).stops[0].fieldConfidence;
    expect(fields({ provenance: 'PLACEHOLDER', address: 'Bremen', company: 'Seifert', city: 'Bremen' })).toMatchObject({
      address: { score: 0.4, level: 'DOUBT', reasons: expect.arrayContaining(['PLACEHOLDER']) }, company: { level: 'DOUBT' }
    });
    // A learned site rule is as good as printed, even for a placeholder.
    expect(fields({ provenance: 'PLACEHOLDER', ruleApplied: true }).address).toMatchObject({ score: 0.95, level: 'OK', reasons: ['ADDRESS_RULE'] });
    expect(fields({ provenance: 'DEPARTMENT' }).address).toMatchObject({ score: 0.9, reasons: ['DEPARTMENT'] });
    expect(fields({ provenance: 'OTHER_STOP_NOTE', confidence: 0.9 }).address).toMatchObject({ score: 0.55, reasons: ['FROM_OTHER_STOP_NOTE'] });
    expect(fields({ provenance: 'PLACEHOLDER', aliasApplied: true, company: 'Mercedes-Benz AG' }).company).toMatchObject({ score: 0.9, reasons: expect.arrayContaining(['ALIAS_APPLIED']) });
    expect(fields({ provenance: 'TOUR_REMARKS', confidence: 0.8 }).type).toMatchObject({ score: 0.9, reasons: ['TOUR_REMARKS_MATCH'] });
  });

  it('holds back fields a warning is about and fields this customer often corrects', () => {
    const warned = draft([stop()], { warnings: [
      { code: 'TOUR_REMARKS_STOP_FROM_NOTES', message: 'x', stopIndex: 0, field: 'address' },
      { code: 'DATE_ONLY', message: 'y', stopIndex: 0, field: 'time' }
    ] });
    const fields = scoreDraft(warned, context).stops[0].fieldConfidence;
    expect(fields.address).toMatchObject({ score: 0.6, reasons: ['WARNING'] });
    expect(fields.time).toMatchObject({ level: 'OK' });
    const history = scoreDraft(draft([stop()]), { ...context, correctionRate: { company: 0.4, city: 0.1 } }).stops[0].fieldConfidence;
    expect(history.company).toMatchObject({ score: 0.75, level: 'CHECK', reasons: ['OFTEN_CORRECTED'] });
    expect(history.city).toMatchObject({ level: 'OK' });
    expect(correctionRates(4, [{ field: 'company', documents: 4 }])).toEqual({});
    expect(correctionRates(10, [{ field: 'company', documents: 4 }, { field: null, documents: 9 }])).toEqual({ company: 0.4 });
  });

  it('doubts a missing Auftrag number and counts the doubts', () => {
    const scored = scoreDraft(draft([stop({ address: 'Bremen' })], { orderNumber: null }), context);
    expect(scored.orderConfidence.orderNumber).toMatchObject({ level: 'DOUBT', reasons: ['MISSING'] });
    expect(scored.confidenceSummary.doubt).toBe(2);
  });
});

describe('calibration', () => {
  it('compares each scored field with what the dispatcher saved', () => {
    const preview = scoreDraft(draft([stop(), stop({ type: 'UNLOAD', address: 'Bremen', company: 'Seifert', city: 'Bremen', provenance: 'PLACEHOLDER' })]), context).stops;
    const outcomes = fieldOutcomes(preview, [
      { draftStopIndex: 0, type: 'LOAD', company: 'Hydro Aluminium', address: 'Robert-Koch-Str. 4, 08451 Crimmitschau', city: 'Crimmitschau', appointmentAt: '2026-11-10T07:00:00.000Z', loadingMeters: 13.6, referenceNumbers: ['477339'] },
      { draftStopIndex: 1, type: 'UNLOAD', company: 'Seifert Logistics', address: 'Hafenstraße 5, 28197 Bremen', city: 'Bremen', appointmentAt: '2026-11-10T07:00:00.000Z', loadingMeters: 13.6, referenceNumbers: ['477339'] }
    ]);
    expect(outcomes.filter((item) => item.changed).map((item) => item.field).sort()).toEqual(['address', 'company']);
    // The placeholder's address was a doubt and was corrected; its company was to be checked and was renamed.
    expect(calibrate(outcomes)).toMatchObject({ OK: { changed: 0 }, CHECK: { changed: 1 }, DOUBT: { fields: 1, changed: 1 } });
    expect(fieldOutcomes(preview.slice(0, 1), []).every((item) => item.changed)).toBe(true);
  });
});

describe('the PDF reader', () => {
  it('asks the model for a score per field, keeps it for scoring and ties warnings and placeholders to their stop', async () => {
    let schema = '';
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body));
      schema = JSON.stringify(body.text.format.schema);
      return new Response(JSON.stringify({ output_text: JSON.stringify({ warnings: [], drafts: [{
        orderNumber: '1', vehicleNumber: null, vehiclePlate: null, trailerPlate: null, tourRemarks: 'Hydro Crimmitschau für Seifert Bremen', tourRemarksSourcePage: 1,
        departmentCompany: null, departmentAddress: null, departmentCity: null, departmentSourcePage: null,
        orderFieldConfidence: { orderNumber: ai(0.9, 'Auftrag 1'), vehicle: ai(0, null), trailer: ai(0, null) },
        warnings: [{ code: 'LM_UNCLEAR', message: 'LM неразборчиво', sourcePage: 1, stopSequence: 1, field: 'loadingMeters' }],
        stops: [{ sequence: 1, type: 'LOAD', company: 'Hydro', address: 'Robert-Koch-Str. 4, 08451 Crimmitschau', city: 'Crimmitschau', appointmentLocal: null, appointmentWindowStartLocal: null,
          appointmentWindowEndLocal: null, appointmentDateLocal: null, loadingMeters: 13.6, referenceNumbers: [], instructions: null, sourcePage: 1, sourceExcerpt: 'Hydro Crimmitschau', confidence: 0.9,
          fieldConfidence: { type: ai(0.9), company: ai(0.9, 'Hydro'), address: ai(0.9, 'Robert-Koch-Str. 4'), city: ai(0.9), time: ai(0), loadingMeters: ai(0.5, 'LM 13,6'), references: ai(0) } }]
      }] }) }), { status: 200 });
    });
    const preview = await importPdfPreview(Buffer.from('%PDF-1.7'), 'a.pdf', { apiKey: 'test', fetchImpl: fetchMock as typeof fetch, now: new Date('2026-11-08T10:00:00Z') });
    expect(schema).toContain('"fieldConfidence"');
    expect(schema).toContain('"orderFieldConfidence"');
    expect(schema).toContain('"stopSequence"');
    const [load, unload] = preview.drafts[0].stops;
    expect(load).toMatchObject({ provenance: 'TOUR_REMARKS', aiConfidence: { address: { c: 0.9, evidence: 'Robert-Koch-Str. 4' } } });
    expect(load).not.toHaveProperty('fieldConfidence');
    expect(unload).toMatchObject({ provenance: 'PLACEHOLDER', company: 'Seifert', address: 'Bremen' });
    expect(preview.drafts[0].orderAiConfidence).toMatchObject({ orderNumber: { c: 0.9 } });
    expect(preview.drafts[0].warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LM_UNCLEAR', stopIndex: 0, field: 'loadingMeters' }),
      expect.objectContaining({ code: 'TOUR_REMARKS_STOP_NOT_FOUND', stopIndex: 1, field: 'address' })
    ]));
  });
});

describe('accuracy in the customer profile', () => {
  let directory: string;
  let db: PrismaClient;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-field-confidence-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
  });
  afterEach(async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); });

  it('shows how often each level was corrected in the saved Auftrag', async () => {
    const service = new CustomerService(asAppDatabase(db));
    const customer = await db.customer.create({ data: { slug: 'SCHNELLECKE', name: 'Schnellecke' } });
    expect((await service.get(customer.id)).overview.accuracy).toBeNull();
    const scored = scoreDraft(draft([stop(), stop({ type: 'UNLOAD', address: 'Bremen', company: 'Seifert', city: 'Bremen', provenance: 'PLACEHOLDER' })]), context);
    await db.orderDocument.create({ data: { sha256: 'f'.repeat(64), filename: 'a.pdf', mimeType: 'application/pdf', size: 1, content: Buffer.from('a'), status: 'ATTACHED', attachedAt: new Date(), customerId: customer.id,
      previewJson: JSON.stringify({ drafts: [scored] }),
      confirmedJson: JSON.stringify({ orderNumber: '71123727', stops: [
        { draftStopIndex: 0, type: 'LOAD', company: 'Hydro Aluminium', address: 'Robert-Koch-Str. 4, 08451 Crimmitschau', city: 'Crimmitschau', appointmentAt: '2026-11-10T07:00:00.000Z', loadingMeters: 13.6, referenceNumbers: ['477339'] },
        { draftStopIndex: 1, type: 'UNLOAD', company: 'Seifert', address: 'Hafenstraße 5, 28197 Bremen', city: 'Bremen', appointmentAt: '2026-11-10T07:00:00.000Z', loadingMeters: 13.6, referenceNumbers: ['477339'] }
      ] }) } });
    const accuracy = (await service.get(customer.id)).overview.accuracy;
    expect(accuracy?.OK).toEqual({ fields: expect.any(Number), changed: 0 });
    expect(accuracy?.DOUBT).toEqual({ fields: 1, changed: 1 });
  });
});
