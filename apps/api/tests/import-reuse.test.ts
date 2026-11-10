import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { registerOrderDocumentRoutes, registerOrderReparseRoute } from '../src/routes/order-documents.js';
import { CustomerService } from '../src/services/customers.js';
import type { DispatcherRole } from '../src/services/dispatcher-auth.js';
import { readingFromStore } from '../src/services/import-reuse.js';
import { OrderDocumentService, storedAnswerOf } from '../src/services/order-documents.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';
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

describe('the same file is not read by the model twice', () => {
  let db: PrismaClient;
  let directory: string;
  const apps: Array<ReturnType<typeof Fastify>> = [];
  const nobody = { cards: [], selected: null };
  const noRules = async () => null;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-reuse-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
    vi.stubEnv('OPENAI_IMPORT_MODEL', 'gpt-test');
  }, 20_000);
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function storedReading(file: string) {
    const documents = new OrderDocumentService(asAppDatabase(db));
    const buffer = Buffer.from(`%PDF-1.7 ${file}`);
    const { preview } = await read({ now: new Date().toISOString() });
    const stats = { model: 'gpt-test', totalMs: 7000 };
    const stored = await documents.store({ buffer, filename: `${file}.pdf`, mimeType: 'application/pdf', previewJson: { ...preview, readStats: stats } });
    return { documents, buffer, preview, stored, stats };
  }

  it('finds the answer by the bytes of the file and works it out by the rules of now', async () => {
    const { documents, buffer, preview, stats } = await storedReading('first');
    const before = await documents.modelAnswerOf(buffer);
    expect(before).toMatchObject({ status: 'PENDING', readStats: stats, answer: { v: 1, layout: 'PDF' } });

    const reused = await readingFromStore(before, 'PDF', nobody, noRules);
    expect(reused).toMatchObject({ answerReused: true, readStats: stats });
    expect(reused!.drafts).toEqual(preview.drafts);
    expect(reused!.warnings.map((warning) => warning.code)).toEqual(['DOCUMENT_REUSED']);

    // Another file, another kind of reading, another model or an answer older than a week: the model reads it.
    expect(await documents.modelAnswerOf(Buffer.from('%PDF-1.7 other'))).toBeNull();
    expect(await readingFromStore(before, 'IMAGE', nobody, noRules)).toBeNull();
    expect(await readingFromStore(before, 'PDF', nobody, noRules, Date.now() + 8 * 24 * 3600_000)).toBeNull();
    vi.stubEnv('OPENAI_IMPORT_MODEL', 'gpt-next');
    expect(await readingFromStore(before, 'PDF', nobody, noRules)).toBeNull();
    vi.stubEnv('OPENAI_IMPORT_MODEL', 'gpt-test');
    expect(await readingFromStore({ ...before!, answer: { ...before!.answer, answer: { drafts: 'broken' } } }, 'PDF', nobody, noRules)).toBeNull();
  });

  function build(role: DispatcherRole | null) {
    const documents = new OrderDocumentService(asAppDatabase(db));
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.dispatcherSession = role ? { token: 't', expiresAt: Number.MAX_SAFE_INTEGER, role, sessionId: 's', dispatcherId: 'd1', displayName: 'Test' } : null;
    });
    const asked = vi.fn();
    registerOrderDocumentRoutes(app, documents);
    registerOrderReparseRoute(app, {
      documents, customers: new CustomerService(asAppDatabase(db)), db: asAppDatabase(db),
      read: async () => { asked(); return { status: 502, error: 'the model must not be asked' }; },
      recompute: async (_file, previewJson, customer) => {
        const again = await readingFromStore(storedAnswerOf({ id: '', status: 'PENDING', previewJson }), 'PDF', customer, noRules);
        return again ? { preview: { ...again, customer: null } } : { status: 409, error: 'нет сохранённого ответа ИИ' };
      },
      store: async (preview, file) => {
        const stored = await documents.store({ buffer: file.content, filename: file.filename, mimeType: file.mimeType, previewJson: preview });
        return { ...preview, modelAnswer: undefined, documentId: stored.id };
      }
    });
    apps.push(app);
    return { app, documents, asked };
  }

  it('POST /documents/:id/refresh works the stored answer out again without the model and writes the audit log', async () => {
    const { stored, preview } = await storedReading('refresh');
    const { app, asked } = build('dispatcher');
    const response = await app.inject({ method: 'POST', url: `/documents/${stored.id}/refresh`, payload: { customerId: null } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ documentId: stored.id, drafts: [{ orderNumber: 'A-1' }] });
    expect(response.json().drafts[0].stops).toHaveLength(preview.drafts[0].stops.length);
    expect(response.body).not.toContain('promptVersion');
    expect(asked).not.toHaveBeenCalled();
    expect(await db.auditLog.findFirst({ where: { action: 'ORDER_DOCUMENT_REFRESHED' } })).toMatchObject({ entityId: stored.id, actorRole: 'dispatcher' });
    // The answer is still there for the next time.
    expect(JSON.parse((await db.orderDocument.findUniqueOrThrow({ where: { id: stored.id } })).previewJson)).toMatchObject({ modelAnswer: { v: 1 } });
  });

  it('refuses a document without a stored answer, an unknown one, a bad body and anonymous callers', async () => {
    const { app, documents } = build('dispatcher');
    const old = await documents.store({ buffer: Buffer.from('%PDF-1.7 no answer'), filename: 'old.pdf', mimeType: 'application/pdf', previewJson: { drafts: [] } });
    expect((await app.inject({ method: 'POST', url: `/documents/${old.id}/refresh`, payload: { customerId: null } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/documents/nope/refresh', payload: { customerId: null } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/documents/${old.id}/refresh`, payload: { customerId: 7 } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await build(null).app.inject({ method: 'POST', url: `/documents/${old.id}/refresh`, payload: { customerId: null } })).statusCode).toBe(401);
  });

  it('never sends the stored model answer to the page', async () => {
    const { stored } = await storedReading('shown');
    const response = await build('dispatcher').app.inject({ method: 'GET', url: `/documents/${stored.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: stored.id, preview: { drafts: [{ orderNumber: 'A-1' }] } });
    expect(response.body).not.toContain('modelAnswer');
    expect(response.body).not.toContain('promptVersion');
  });
});
