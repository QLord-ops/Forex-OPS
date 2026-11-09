import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { registerOrderReparseRoute } from '../src/routes/order-documents.js';
import { AddressRuleService } from '../src/services/address-rules.js';
import { customerProfileSchema, OEM_TOUR_REMARKS_TEMPLATE, SCHNELLECKE_PROFILE } from '../src/services/customer-profile.js';
import { detectCustomer, resolveImportCustomer, vehicleKey, type CustomerCard } from '../src/services/customer-resolver.js';
import { CustomerError, CustomerService } from '../src/services/customers.js';
import type { DispatcherRole } from '../src/services/dispatcher-auth.js';
import { ImportLearningService } from '../src/services/import-learning.js';
import { OrderDocumentService } from '../src/services/order-documents.js';
import { DEFAULT_TIMEOUT_MS, importPdfPreview, importReasoningEffort, parseTourRemarksRoute, withBuiltInImportRules, type ImportCustomerContext } from '../src/services/pdf-order-import.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { TourService } from '../src/services/tours.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

const schnellecke: CustomerCard = { id: 'c-sl', key: 'SCHNELLECKE', name: 'Schnellecke', aliases: ['Schnellecke', 'Schnellecke Transportlogistik GmbH'], carrierNames: ['Schnellecke Transportlogistik'] };
const walter: CustomerCard = { id: 'c-wt', key: 'WALTER_TESLA', name: 'Walter (Tesla)', aliases: ['Walter', 'Tesla'], carrierNames: [] };
const cards = [schnellecke, walter];

describe('whose Auftrag it is', () => {
  it('trusts the letterhead and Abteilung most, adds the AI answer and the truck line, and never a place on the route', () => {
    expect(detectCustomer(cards, { documentIssuer: 'Schnellecke Transportlogistik GmbH', customerKey: 'SCHNELLECKE', departmentCompanies: [] }, ['c-wt']))
      .toEqual({ id: 'c-sl', key: 'SCHNELLECKE', name: 'Schnellecke', source: 'DOCUMENT', confidence: 0.99 });
    // A Schnellecke Auftrag to Tesla: the Abteilung names Tesla and the AI guesses Walter, the letterhead still decides.
    expect(detectCustomer(cards, { documentIssuer: 'Schnellecke Transportlogistik GmbH', customerKey: 'WALTER_TESLA', departmentCompanies: ['Tesla Manufacturing Brandenburg SE'] }))
      .toMatchObject({ id: 'c-sl', source: 'DOCUMENT' });
    // Signed only with its Spedition name.
    expect(detectCustomer(cards, { documentIssuer: 'Schnellecke Transportlogistik', customerKey: null, departmentCompanies: [] })).toMatchObject({ id: 'c-sl', source: 'DOCUMENT' });
    // "für Tesla Grünheide" is a stop of a Schnellecke tour: stops are not evidence, so the truck alone decides.
    expect(detectCustomer(cards, { documentIssuer: null, customerKey: null, departmentCompanies: [] }, ['c-sl'])).toMatchObject({ id: 'c-sl', source: 'VEHICLE', confidence: 0.3 });
    expect(detectCustomer(cards, { documentIssuer: null, customerKey: null, departmentCompanies: ['Schnellecke Logistics Ludwigsfelde'] })).toMatchObject({ id: 'c-sl', source: 'DOCUMENT' });
    expect(detectCustomer(cards, { documentIssuer: null, customerKey: 'walter_tesla', departmentCompanies: [] })).toMatchObject({ id: 'c-wt', source: 'AI' });
    // The AI says Walter, the truck drives for Schnellecke: no answer rather than a guess.
    expect(detectCustomer(cards, { documentIssuer: null, customerKey: 'WALTER_TESLA', departmentCompanies: [] }, ['c-sl'])).toBeNull();
    expect(detectCustomer(cards, { documentIssuer: 'Spedition Müller', customerKey: null, departmentCompanies: [] })).toBeNull();
  });

  it('keeps the chosen customer, points at another letterhead and asks when nothing is known', () => {
    const evidence = { documentIssuer: 'Walter Logistics GmbH', customerKey: null, departmentCompanies: [] };
    const chosen = resolveImportCustomer({ cards, selectedId: 'c-sl', evidence });
    expect(chosen.customer).toMatchObject({ id: 'c-sl', source: 'SELECTED', profileApplied: true, detected: { id: 'c-wt', source: 'DOCUMENT' } });
    expect(chosen.warnings).toEqual([expect.objectContaining({ code: 'CUSTOMER_MISMATCH', message: expect.stringContaining('Walter (Tesla)') })]);
    expect(resolveImportCustomer({ cards, selectedId: 'c-wt', evidence }).warnings).toEqual([]);

    const detected = resolveImportCustomer({ cards, selectedId: null, evidence });
    expect(detected).toEqual({ customer: expect.objectContaining({ id: 'c-wt', profileApplied: false }), warnings: [] });
    expect(resolveImportCustomer({ cards, selectedId: null }).warnings).toEqual([expect.objectContaining({ code: 'CUSTOMER_UNKNOWN' })]);
    expect(resolveImportCustomer({ cards: [], selectedId: null })).toEqual({ customer: null, warnings: [] });
  });

  it('matches a truck however the Auftrag prints it', () => {
    expect(vehicleKey('LKW 936')).toBe(vehicleKey('936'));
    expect(vehicleKey('GÖ-FX 997')).toBe(vehicleKey('GÖ FX997'));
    expect(vehicleKey(null)).toBe('');
  });
});

describe('the prompt follows the customer profile', () => {
  const stop = (sequence: number, type: 'LOAD' | 'UNLOAD', extra: Record<string, unknown> = {}) => ({
    sequence, type, company: type === 'LOAD' ? 'Werk Göttingen' : 'Audi AG', address: type === 'LOAD' ? 'Otto-Brenner-Str. 20, 37079 Göttingen' : 'Auto-Union-Str. 1, 85057 Ingolstadt',
    city: null, appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null, appointmentDateLocal: null,
    loadingMeters: null, referenceNumbers: [], instructions: null, sourcePage: 1, sourceExcerpt: null, confidence: 0.9, ...extra
  });
  async function read(customer: ImportCustomerContext | null, answer: Record<string, unknown> = {}) {
    let body: { input: unknown; text: { format: { schema: { required: string[] } } } } | null = null;
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output_text: JSON.stringify({ drafts: [{
        orderNumber: 'A-1', vehicleNumber: null, vehiclePlate: null, trailerPlate: null, tourRemarks: null, tourRemarksSourcePage: null,
        departmentCompany: 'Walter Logistics Grünheide', departmentAddress: null, departmentCity: null, departmentSourcePage: null,
        stops: [stop(1, 'LOAD', { appointmentDateLocal: '2026-11-10' }), stop(2, 'UNLOAD')], warnings: [] }], warnings: [], ...answer }) }), { status: 200 });
    });
    const preview = await importPdfPreview(Buffer.from('%PDF-1.7'), 'auftrag.pdf', { apiKey: 'test', fetchImpl: fetchMock as typeof fetch, now: new Date('2026-11-08T10:00:00Z'), customer });
    return { preview, instruction: JSON.stringify(body!.input), required: body!.text.format.schema.required, schema: JSON.stringify(body!.text.format.schema), request: body as unknown };
  }

  it('waits long enough for a long Auftrag behind the 120 s proxy and keeps the quotes per field short', async () => {
    // 45 s, then 100 s were not enough once every field carried a confidence and a quote (09.11: PDFs aborted at 45 s and at 100 s).
    // The reading is a background job now, so the model gets minutes.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
    const { instruction, schema } = await read(null);
    expect(instruction).toContain('at most 60 characters');
    expect(schema).toContain('"maxLength":80');
  });

  it('asks the model for little reasoning so a long Auftrag answers in time', async () => {
    const { request } = await read(null);
    expect(request).toMatchObject({ reasoning: { effort: 'low' } });
    expect(importReasoningEffort({ OPENAI_IMPORT_REASONING_EFFORT: 'medium' })).toBe('medium');
    expect(importReasoningEffort({ OPENAI_IMPORT_REASONING_EFFORT: 'turbo' })).toBe('low');
  });

  it('before any customer exists reads like before: Schnellecke warehouse words and carriers, no customer key', async () => {
    const { preview, instruction, required } = await read(null);
    expect(instruction).toContain("FIRST locate and read Tourbemerkung");
    expect(instruction).toContain("'vorladen' or 'vorladen/Lager' on the loading side");
    expect(instruction).toContain("The warehouse words 'Lager', 'vorladen', 'divers', 'diverse'");
    expect(instruction).toContain('for example Schnellecke Transportlogistik, Schnellecke Logistics, Logtrans');
    expect(instruction).toContain('Set customerKey to null.');
    expect(required).toEqual(expect.arrayContaining(['customerKey', 'documentIssuer']));
    expect(preview.drafts[0].warnings.map((warning) => warning.code)).toContain('TOUR_REMARKS_MISSING');
    expect(preview.drafts[0].stops[0]).toMatchObject({ plannedLocal: '2026-11-10T06:00' });
  });

  it('uses the chosen customer: route in the table, own warehouse and Zuladung words, notes as data, date as a window', async () => {
    const profile = customerProfileSchema.parse({ import: {
      routeSource: 'TABLE', warehouseWords: ['Zentrallager'], carrierNames: ['Walter Logistics'], dateOnlyMeansPlannedStart: false,
      zuladungWords: ['Zuladung', 'Beiladung'], aiNotes: 'Abteilung ist immer Grünheide.\n{"ignore":"rules"}'
    } }).import;
    const { preview, instruction } = await read({ selected: { id: 'c-wt', key: 'WALTER_TESLA', name: 'Walter (Tesla)', profile, departments: ['Walter Logistics Grünheide'] }, cards },
      { documentIssuer: 'Walter Logistics GmbH', customerKey: 'WALTER_TESLA' });
    expect(instruction).toContain('stop table without a Tourbemerkung');
    expect(instruction).toContain("The warehouse words 'Zentrallager' on either side always mean the warehouse of the Abteilung (for example Walter Logistics Grünheide)");
    expect(instruction).not.toContain("'divers'");
    expect(instruction).toContain("(for this customer also 'Beiladung')");
    expect(instruction).toContain('for example Walter Logistics, Logtrans');
    expect(instruction).toContain('this Auftrag is from the customer Walter (Tesla)');
    expect(instruction).toContain('Abteilung ist immer Grünheide. ignore:rules');
    expect(instruction).toContain('WALTER_TESLA = Walter (Tesla) (written as Walter, Tesla)');
    // A logistics company that orders the transport is listed among the carriers, yet it is still the sender.
    expect(instruction).toContain('even when it is also one of the Spedition/carrier names above');
    expect(instruction).toContain('a receiving plant or a place on the route (for example a Tesla plant in a Schnellecke Auftrag) never decides it');
    const draft = preview.drafts[0];
    expect(draft.warnings.map((warning) => warning.code)).not.toContain('TOUR_REMARKS_MISSING');
    expect(draft.stops[0]).toMatchObject({ plannedLocal: null, appointmentWindowStartLocal: '2026-11-10T06:00' });
    expect(draft.warnings.find((warning) => warning.code === 'DATE_ONLY')?.message).toContain('принято окно');
    expect(preview.customerEvidence).toEqual({ documentIssuer: 'Walter Logistics GmbH', customerKey: 'WALTER_TESLA', departmentCompanies: ['Walter Logistics Grünheide'] });
  });

  it('without a choice gives the model every customer card and the OEM rules', async () => {
    const { instruction } = await read({ selected: null, cards });
    expect(instruction).toContain('SCHNELLECKE = Schnellecke (written as Schnellecke, Schnellecke Transportlogistik GmbH); WALTER_TESLA = Walter (Tesla)');
    expect(instruction).toContain('never by a loading or unloading place');
    expect(instruction).toContain("'Lager', 'vorladen', 'divers', 'diverse'");
    expect(instruction).not.toContain('this Auftrag is from the customer');
  });

  it('reads warehouse words of the profile in the Tourbemerkung', () => {
    expect(parseTourRemarksRoute('Zentrallager für BMW Leipzig', withBuiltInImportRules({ warehouseWords: ['Zentrallager'] }))?.[0]).toMatchObject({ addressSource: 'DEPARTMENT', type: 'LOAD' });
    expect(parseTourRemarksRoute('Zentrallager für BMW Leipzig')?.[0]).toMatchObject({ addressSource: 'TOUR_REMARKS' });
    expect(parseTourRemarksRoute('vorladen für BMW Leipzig')?.[0]).toMatchObject({ addressSource: 'DEPARTMENT' });
    expect(parseTourRemarksRoute('Lager für BMW Leipzig', withBuiltInImportRules({ warehouseWords: [] }))?.[0]).toMatchObject({ addressSource: 'TOUR_REMARKS' });
  });
});

describe('with a database', () => {
  let directory: string;
  let db: PrismaClient;
  const actor = { role: 'dispatcher' as const, sessionId: 's1', dispatcherId: 'd1' };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-customer-import-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
  });
  afterEach(async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); });

  const customer = (slug: string, name: string, extra: Record<string, unknown> = {}) =>
    db.customer.create({ data: { slug, name, aliasesJson: JSON.stringify([name]), profileJson: JSON.stringify(SCHNELLECKE_PROFILE), ...extra } });

  describe('learning per customer', () => {
    const previewStops = [
      { sequence: 1, type: 'LOAD' as const, company: 'MB', address: 'Düsseldorf', city: 'Düsseldorf', sourceExcerpt: 'MB Düsseldorf 477339 070A', sourceLabel: 'MB Düsseldorf' },
      { sequence: 2, type: 'LOAD' as const, company: 'LG', address: 'LG', city: null, sourceExcerpt: '070D LG' },
      { sequence: 3, type: 'UNLOAD' as const, company: 'Schnellecke Transportlogistik GmbH', address: 'Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde', city: 'Ludwigsfelde', sourceExcerpt: 'Abteilung' }
    ];
    const confirmedStops = [
      { sequence: 1, type: 'LOAD' as const, company: 'Mercedes-Benz AG / Werk 065', address: 'Toulouser Allee 26, 40476 Düsseldorf', city: 'Düsseldorf', draftStopIndex: 0 },
      { sequence: 2, type: 'UNLOAD' as const, company: 'Schnellecke Transportlogistik GmbH', address: 'Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde', city: 'Ludwigsfelde', draftStopIndex: 2 }
    ];
    let service: ImportLearningService;
    beforeEach(() => { service = new ImportLearningService(asAppDatabase(db), new AddressRuleService(asAppDatabase(db))); });

    async function confirmFor(customerId: string | null, id: string, tourRemarks = 'MB Düsseldorf 477339 070A & 070D LG --> Lager') {
      const document = await db.orderDocument.create({ data: { sha256: id.padEnd(64, '0'), filename: `${id}.pdf`, mimeType: 'application/pdf', size: 1, content: Buffer.from(id), status: 'ATTACHED',
        attachedAt: new Date(), customerId, previewJson: '{}', confirmedJson: JSON.stringify({ tourRemarks, stops: confirmedStops }) } });
      return service.recordConfirmation({ documentId: document.id, tourId: null, dispatcherId: 'd1', customerId, preview: { drafts: [{ orderNumber: '1', tourRemarks, stops: previewStops }] },
        orderNumber: '1', confirmedStops, tourRemarks, actor });
    }

    it('counts the threshold inside one customer and applies its rules and examples only to it', async () => {
      const [a, b] = [await customer('SCHNELLECKE', 'Schnellecke'), await customer('WALTER_TESLA', 'Walter (Tesla)')];
      await confirmFor(a.id, 'a1');
      await confirmFor(b.id, 'b1', 'MB Düsseldorf & LG für Tesla Grünheide');
      expect(await db.importRule.count({ where: { active: true } })).toBe(0);
      expect(await db.importCorrection.count({ where: { customerId: a.id } })).toBe(3);

      await confirmFor(a.id, 'a2');
      expect(await db.importRule.findUniqueOrThrow({ where: { scope_kind_pattern: { scope: a.id, kind: 'ALIAS', pattern: 'mb' } } })).toMatchObject({ active: true, hits: 2 });
      const forA = await service.learned(a.id);
      expect(forA.aliases.mb).toBe('Mercedes-Benz AG / Werk 065');
      expect(forA.examplesText).toContain('Lager');
      expect(forA.examplesText).not.toContain('Tesla Grünheide');
      const forB = await service.learned(b.id);
      expect(forB.aliases.mb).toBe('Mercedes-Benz AG');
      expect(forB.examplesText).toContain('Tesla Grünheide');
      expect((await service.learned()).aliases.mb).toBe('Mercedes-Benz AG');
    });

    it('offers a rule learned at two customers as a common one and makes it common on request', async () => {
      const [a, b] = [await customer('SCHNELLECKE', 'Schnellecke'), await customer('WALTER_TESLA', 'Walter (Tesla)')];
      for (const [owner, id] of [[a.id, 'a1'], [a.id, 'a2'], [b.id, 'b1']] as const) await confirmFor(owner, id);
      const once = (await service.list()).find((rule) => rule.kind === 'ALIAS' && rule.scope === a.id)!;
      expect(once).toMatchObject({ active: true, promotable: false, customer: { id: a.id, name: 'Schnellecke' } });
      await expect(service.promote(once.id, actor)).rejects.toMatchObject({ statusCode: 409 });

      await confirmFor(b.id, 'b2');
      const rules = await service.list(b.id);
      expect(rules.every((rule) => rule.scope === b.id || rule.scope === 'global')).toBe(true);
      const offered = rules.find((rule) => rule.kind === 'ALIAS')!;
      expect(offered.promotable).toBe(true);
      const common = await service.promote(offered.id, actor);
      expect(common).toMatchObject({ scope: 'global', kind: 'ALIAS', pattern: 'mb', active: true, hits: 4 });
      expect(await db.importRule.count({ where: { kind: 'ALIAS', scope: { not: 'global' } } })).toBe(0);
      expect((await service.learned()).aliases.mb).toBe('Mercedes-Benz AG / Werk 065');
      expect(await db.auditLog.count({ where: { action: 'IMPORT_RULE_PROMOTED' } })).toBe(1);
      await expect(service.promote(common.id, actor)).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  it('gives the import every active customer as a card and the chosen one with its warehouses', async () => {
    const service = new CustomerService(asAppDatabase(db));
    const sl = await customer('SCHNELLECKE', 'Schnellecke', { aliasesJson: JSON.stringify(['Schnellecke', 'Schnellecke Logistics']) });
    await db.customerLine.create({ data: { customerId: sl.id, code: 'LUFE', name: 'LuFe', departmentCompany: 'Schnellecke Logistics', departmentCity: 'Ludwigsfelde' } });
    await db.customerLine.create({ data: { customerId: sl.id, code: 'OLD', name: 'Alt', departmentCompany: 'Lager Alt', active: false } });
    const archived = await customer('OLD_KUNDE', 'Alt', { active: false });

    const context = await service.importContext(sl.id);
    expect(context.cards).toEqual([{ id: sl.id, key: 'SCHNELLECKE', name: 'Schnellecke', aliases: ['Schnellecke', 'Schnellecke Logistics'], carrierNames: SCHNELLECKE_PROFILE.import.carrierNames }]);
    expect(context.selected).toMatchObject({ id: sl.id, key: 'SCHNELLECKE', departments: ['Schnellecke Logistics Ludwigsfelde'], profile: { routeSource: 'TOUR_REMARKS', warehouseWords: OEM_TOUR_REMARKS_TEMPLATE.import.warehouseWords } });
    expect((await service.importContext(null)).selected).toBeNull();
    await expect(service.importContext(archived.id)).rejects.toBeInstanceOf(CustomerError);
  });

  it('gives a tour the customer of its Auftrag, else of the truck line, and the line only when it is that customer\'s', async () => {
    const tours = new TourService(asAppDatabase(db), new MockRoutingProvider());
    const [a, b] = [await customer('SCHNELLECKE', 'Schnellecke'), await customer('WALTER_TESLA', 'Walter (Tesla)')];
    const line = await db.customerLine.create({ data: { customerId: a.id, code: 'NORD', name: 'Nord' } });
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: '9724', customerLineId: line.id, line: 'SCHNELLECKE', statusGroup: 'NORD' } });
    const stops = [
      { sequence: 1, type: 'LOAD' as const, address: 'Lindenstraße 4, 85354 Freising', latitude: 48.402, longitude: 11.748, serviceMinMinutes: 60, serviceMaxMinutes: 120 },
      { sequence: 2, type: 'UNLOAD' as const, address: 'Dieselstraße 2, 30890 Barsinghausen', latitude: 52.305, longitude: 9.462, serviceMinMinutes: 60, serviceMaxMinutes: 120 }
    ];
    const own = await tours.createTour({ vehicleId: vehicle.id, orderNumber: 'T-1', stops });
    expect(await db.tour.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ customerId: a.id, customerLineId: line.id });
    const foreign = await tours.createTour({ vehicleId: vehicle.id, orderNumber: 'T-2', customerId: b.id, stops });
    expect(await db.tour.findUniqueOrThrow({ where: { id: foreign.id } })).toMatchObject({ customerId: b.id, customerLineId: null });
    const fresh = await tours.createTourForNewVehicle({ vehicle: { vehicleNumber: '125' }, tour: { orderNumber: 'T-3', customerId: b.id, stops } });
    expect(await db.tour.findUniqueOrThrow({ where: { id: fresh.tour.id } })).toMatchObject({ customerId: b.id, customerLineId: null });
  });

  describe('POST /documents/:id/reparse', () => {
    async function build(role: DispatcherRole | null) {
      const documents = new OrderDocumentService(asAppDatabase(db));
      const contexts: ImportCustomerContext[] = [];
      const app = Fastify();
      app.addHook('onRequest', async (request) => {
        request.dispatcherSession = role ? { token: 't', expiresAt: Number.MAX_SAFE_INTEGER, role, sessionId: 's', dispatcherId: 'd1', displayName: 'Test' } : null;
      });
      registerOrderReparseRoute(app, {
        documents, customers: new CustomerService(asAppDatabase(db)), db: asAppDatabase(db),
        read: async (_file, _previewJson, context) => {
          contexts.push(context);
          const chosen = context.selected;
          return { preview: { drafts: [{ orderNumber: 'R-1', stops: [] }], warnings: [],
            customer: chosen ? { id: chosen.id, key: chosen.key, name: chosen.name, source: 'SELECTED' as const, confidence: 1, profileApplied: true, detected: null } : null } };
        },
        store: async (preview, file) => {
          const stored = await documents.store({ buffer: file.content, filename: file.filename, mimeType: file.mimeType, previewJson: preview, customerId: preview.customer?.id ?? null });
          return { ...preview, documentId: stored.id, documentReused: stored.reused };
        }
      });
      return { app, documents, contexts };
    }

    it('reads the stored file again with the chosen customer and keeps the customer on the document', async () => {
      const walterCustomer = await customer('WALTER_TESLA', 'Walter (Tesla)');
      const { app, documents, contexts } = await build('dispatcher');
      const stored = await documents.store({ buffer: Buffer.from('%PDF-1.7 walter'), filename: 'walter.pdf', mimeType: 'application/pdf', previewJson: { drafts: [] } });

      const response = await app.inject({ method: 'POST', url: `/documents/${stored.id}/reparse`, payload: { customerId: walterCustomer.id } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ documentId: stored.id, customer: { key: 'WALTER_TESLA', profileApplied: true } });
      expect(contexts[0].selected).toMatchObject({ id: walterCustomer.id, profile: { routeSource: 'TOUR_REMARKS' } });
      const saved = await db.orderDocument.findUniqueOrThrow({ where: { id: stored.id } });
      expect(saved.customerId).toBe(walterCustomer.id);
      expect(JSON.parse(saved.previewJson)).toMatchObject({ drafts: [{ orderNumber: 'R-1' }] });
      expect(await db.auditLog.findFirst({ where: { action: 'ORDER_DOCUMENT_REPARSED' } })).toMatchObject({ entityId: stored.id });

      expect((await app.inject({ method: 'POST', url: `/documents/${stored.id}/reparse`, payload: { customerId: null } })).json()).toMatchObject({ customer: null });
      expect((await db.orderDocument.findUniqueOrThrow({ where: { id: stored.id } })).customerId).toBeNull();
    });

    it('refuses a saved Auftrag, an unknown document or customer, and anonymous callers', async () => {
      const { app, documents } = await build('dispatcher');
      const stored = await documents.store({ buffer: Buffer.from('%PDF-1.7 saved'), filename: 'saved.pdf', mimeType: 'application/pdf', previewJson: { drafts: [] } });
      expect((await app.inject({ method: 'POST', url: `/documents/${stored.id}/reparse`, payload: { customerId: 'nobody-here' } })).statusCode).toBe(404);
      const vehicle = await db.vehicle.create({ data: { vehicleNumber: '1' } });
      const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: 'X' } });
      await documents.attach({ documentId: stored.id, tourId: tour.id, vehicleId: vehicle.id, confirmedJson: {} });
      expect((await app.inject({ method: 'POST', url: `/documents/${stored.id}/reparse`, payload: { customerId: null } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: '/documents/missing-document/reparse', payload: { customerId: null } })).statusCode).toBe(404);
      const anonymous = await build(null);
      expect((await anonymous.app.inject({ method: 'POST', url: `/documents/${stored.id}/reparse`, payload: { customerId: null } })).statusCode).toBe(401);
    });
  });
});
