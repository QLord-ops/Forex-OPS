import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { registerOrderDocumentRoutes, safeFilename } from '../src/routes/order-documents.js';
import type { OrderDocumentService } from '../src/services/order-documents.js';
import type { DispatcherRole } from '../src/services/dispatcher-auth.js';

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const pdf = Buffer.from('%PDF-1.7 file');
const meta = { id: 'doc1', sha256: 'a'.repeat(64), filename: 'Transportauftrag.pdf', mimeType: 'application/pdf', size: pdf.length, status: 'ATTACHED', uploadedByDispatcherId: null, vehicleId: 'v1', tourId: 't1', attachedAt: new Date(), createdAt: new Date() };
const discarded: string[] = [];
const service = {
  get: async (id: string) => (id === 'doc1' ? { ...meta, previewJson: '{"drafts":[]}', confirmedJson: null } : null),
  file: async (id: string) => (id === 'doc1' ? { filename: 'Transport auftrag "Nr. 1" / Düsseldorf.pdf', mimeType: 'application/pdf', size: pdf.length, content: pdf } : null),
  forTour: async (tourId: string) => (tourId === 't1' ? meta : null),
  listForVehicle: async (vehicleId: string) => (vehicleId === 'v1' ? [meta] : []),
  discard: async (id: string) => { discarded.push(id); return id === 'doc1'; },
  recentPreviews: async () => [7000, 9000, 31000].map((totalMs, index) => ({
    createdAt: new Date(Date.UTC(2026, 10, 9, 8, index)),
    previewJson: JSON.stringify({ drafts: [{ orderNumber: 'A-1' }], readStats: {
      model: 'gpt-5.4-mini', effort: 'low', serviceTier: 'default', readMode: 'text', extractMs: 200, modelMs: totalMs - 500, postMs: 300,
      inputTokens: 6000, cachedTokens: 3000, outputTokens: 1500, reasoningTokens: 0, settingsRejected: false, contextMs: 0, totalMs } })
  }))
} as unknown as OrderDocumentService;

async function build(role: DispatcherRole | null) {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.dispatcherSession = role ? { token: 't', expiresAt: Number.MAX_SAFE_INTEGER, role, sessionId: 's', dispatcherId: 'd1', displayName: 'Test' } : null;
  });
  registerOrderDocumentRoutes(app, service);
  apps.push(app);
  return app;
}

it('serves the saved Auftrag to a signed-in dispatcher with safe download headers', async () => {
  const app = await build('dispatcher');
  const response = await app.inject({ method: 'GET', url: '/documents/doc1/file' });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('application/pdf');
  expect(response.headers['content-length']).toBe(String(pdf.length));
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['content-disposition']).toContain('inline; filename="Transport auftrag Nr. 1 _ D_sseldorf.pdf"');
  expect(response.headers['content-disposition']).toContain("filename*=UTF-8''Transport%20auftrag%20Nr.%201%20_%20D%C3%BCsseldorf.pdf");
  expect(response.rawPayload.equals(pdf)).toBe(true);
  expect((await app.inject({ method: 'GET', url: '/documents/other/file' })).statusCode).toBe(404);
});

it('requires a session for every read and admin for discarding', async () => {
  const anonymous = await build(null);
  for (const url of ['/documents/doc1', '/documents/doc1/file', '/tours/t1/document', '/vehicles/v1/documents']) {
    expect((await anonymous.inject({ method: 'GET', url })).statusCode).toBe(401);
  }
  const dispatcher = await build('dispatcher');
  expect((await dispatcher.inject({ method: 'GET', url: '/documents/doc1' })).json()).toMatchObject({ id: 'doc1', preview: { drafts: [] }, confirmed: null });
  expect((await dispatcher.inject({ method: 'GET', url: '/tours/t1/document' })).json()).toMatchObject({ id: 'doc1', filename: 'Transportauftrag.pdf' });
  expect((await dispatcher.inject({ method: 'GET', url: '/tours/t2/document' })).statusCode).toBe(404);
  expect((await dispatcher.inject({ method: 'GET', url: '/vehicles/v1/documents?limit=5' })).json()).toMatchObject({ documents: [{ id: 'doc1' }] });
  expect((await dispatcher.inject({ method: 'DELETE', url: '/documents/doc1' })).statusCode).toBe(403);
  const admin = await build('admin');
  expect((await admin.inject({ method: 'DELETE', url: '/documents/doc1' })).statusCode).toBe(200);
  expect((await admin.inject({ method: 'DELETE', url: '/documents/attached' })).statusCode).toBe(409);
  expect(discarded).toEqual(['doc1', 'attached']);
});

it('shows the reading speed to the admin only, as numbers without anything from the documents', async () => {
  expect((await (await build(null)).inject({ method: 'GET', url: '/imports/stats' })).statusCode).toBe(401);
  expect((await (await build('dispatcher')).inject({ method: 'GET', url: '/imports/stats' })).statusCode).toBe(403);
  const response = await (await build('admin')).inject({ method: 'GET', url: '/imports/stats' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ documents: 3, count: 3, targetMs: 10000, medianMs: 9000, p90Ms: 31000, withinTarget: 2, cachedShare: 0.5, modes: { text: 3, file: 0, image: 0 } });
  expect(response.body).not.toContain('A-1');
});

it('never lets a file name break out of the header', () => {
  expect(safeFilename('../../etc/passwd\r\nX: y')).toBe('.._.._etc_passwdX: y');
  expect(safeFilename('   ')).toBe('auftrag');
});
