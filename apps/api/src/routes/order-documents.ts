import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAuditLog, type AuditActor } from '../services/audit-log.js';
import type { ImportCustomer } from '../services/customer-resolver.js';
import type { CustomerService } from '../services/customers.js';
import { requireDispatcherRoles } from '../services/dispatcher-auth.js';
import type { OrderDocumentService } from '../services/order-documents.js';
import type { ImportCustomerContext } from '../services/pdf-order-import.js';

const idParams = z.object({ id: z.string().trim().min(1).max(64) });

function actorOf(request: FastifyRequest): AuditActor | undefined {
  const session = request.dispatcherSession;
  return session ? { role: session.role, sessionId: session.sessionId, dispatcherId: session.dispatcherId } : undefined;
}

/** A file name safe for the Content-Disposition header: no control characters, quotes or path parts. */
export function safeFilename(filename: string) {
  const cleaned = filename.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f"\u007f]/g, '').trim().slice(0, 150);
  return cleaned || 'auftrag';
}

/** The saved Auftrag of a tour: metadata for the card, the file itself for the dispatcher to open. */
export function registerOrderDocumentRoutes(app: FastifyInstance, documents: OrderDocumentService) {
  const roles = requireDispatcherRoles('admin', 'dispatcher');

  app.get('/documents/:id', { preHandler: roles }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const document = await documents.get(id);
    if (!document) return reply.status(404).send({ error: 'Auftrag не найден.' });
    const parse = (text: string | null) => { try { return text ? JSON.parse(text) as unknown : null; } catch { return null; } };
    return { ...document, previewJson: undefined, confirmedJson: undefined, preview: parse(document.previewJson), confirmed: parse(document.confirmedJson) };
  });

  app.get('/documents/:id/file', { preHandler: roles, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const file = await documents.file(id);
    if (!file) return reply.status(404).send({ error: 'Файл Auftrag не найден или срок его хранения истёк.' });
    const name = safeFilename(file.filename);
    return reply
      .header('Content-Type', file.mimeType)
      .header('Content-Length', file.content.length)
      .header('Content-Disposition', `inline; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.content);
  });

  app.get('/tours/:id/document', { preHandler: roles }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const document = await documents.forTour(id);
    if (!document) return reply.status(404).send({ error: 'У этого тура нет сохранённого Auftrag.' });
    return document;
  });

  app.get('/vehicles/:id/documents', { preHandler: roles }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(request.query);
    return { documents: await documents.listForVehicle(id, limit) };
  });

  app.delete('/documents/:id', { preHandler: requireDispatcherRoles('admin') }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const removed = await documents.discard(id, actorOf(request));
    if (!removed) return reply.status(409).send({ error: 'Удалить можно только Auftrag, который ещё не сохранён в туре.' });
    return { ok: true };
  });
}

type StoredFile = { content: Buffer; filename: string; mimeType: string };
type ReparsedPreview = { customer?: ImportCustomer | null; documentKind?: string; drafts: Array<unknown>; warnings: Array<{ code: string; message: string }> };

export type OrderReparseDeps = {
  documents: OrderDocumentService;
  customers: Pick<CustomerService, 'importContext'>;
  db: PrismaClient;
  /** Reads the stored file again for this customer (AI for PDF and images, the stored parse for Excel). */
  read: (file: StoredFile, previewJson: string, customer: ImportCustomerContext, request: FastifyRequest) => Promise<{ preview: ReparsedPreview } | { status: number; error: string }>;
  /** Saves the new parse on the same document row (same file, same sha256) and returns what the client gets. */
  store: (preview: ReparsedPreview, file: StoredFile, request: FastifyRequest) => Promise<unknown>;
};

/**
 * Another customer picked in the check: the stored file is read again with that customer's profile, without a new
 * upload. Only a document no tour was saved from; a saved one is history.
 */
export function registerOrderReparseRoute(app: FastifyInstance, deps: OrderReparseDeps) {
  app.post('/documents/:id/reparse', { preHandler: requireDispatcherRoles('admin', 'dispatcher'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { customerId } = z.object({ customerId: z.string().trim().min(1).max(64).nullable() }).parse(request.body ?? {});
    const document = await deps.documents.get(id);
    if (!document) return reply.status(404).send({ error: 'Auftrag не найден.' });
    if (document.status !== 'PENDING') return reply.status(409).send({ error: 'Auftrag уже сохранён в туре — разобрать заново можно только до сохранения.' });
    const file = await deps.documents.file(id);
    if (!file) return reply.status(410).send({ error: 'Файл Auftrag больше не хранится — загрузите его заново.' });
    const context = await deps.customers.importContext(customerId);
    const result = await deps.read(file, document.previewJson, context, request);
    if ('error' in result) return reply.status(result.status).send({ error: result.error });
    const stored = await deps.store(result.preview, file, request);
    await writeAuditLog(deps.db, actorOf(request), { action: 'ORDER_DOCUMENT_REPARSED', entityType: 'OrderDocument', entityId: id,
      metadata: { from: document.customerId, customerId, customer: result.preview.customer?.key ?? null } });
    return stored;
  });
}
