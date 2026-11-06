import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditActor } from '../services/audit-log.js';
import { requireDispatcherRoles } from '../services/dispatcher-auth.js';
import type { OrderDocumentService } from '../services/order-documents.js';

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
