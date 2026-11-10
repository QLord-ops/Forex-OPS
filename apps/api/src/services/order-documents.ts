import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { writeAuditLog, type AuditActor } from './audit-log.js';
import { storedModelAnswerOf } from './pdf-order-import.js';

const DAY_MS = 24 * 3600_000;

/** Everything about a document except its bytes: lists and tour cards never carry the file. */
export const DOCUMENT_SELECT = {
  id: true, sha256: true, filename: true, mimeType: true, size: true, status: true,
  uploadedByDispatcherId: true, vehicleId: true, tourId: true, customerId: true, attachedAt: true, createdAt: true
} satisfies Prisma.OrderDocumentSelect;

export type OrderDocumentMeta = Prisma.OrderDocumentGetPayload<{ select: typeof DOCUMENT_SELECT }>;

export interface OrderDocumentOptions {
  /** Days an unattached upload is kept before it is deleted (default 7). */
  pendingTtlDays?: number;
  /** Days the bytes of an attached Auftrag are kept; the row with its parse stays (default 365). */
  retentionDays?: number;
}

export function readDocumentOptions(env: NodeJS.ProcessEnv = process.env): Required<OrderDocumentOptions> {
  const days = (value: string | undefined, fallback: number) => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return { pendingTtlDays: days(env.ORDER_DOCUMENT_PENDING_TTL_DAYS, 7), retentionDays: days(env.ORDER_DOCUMENT_RETENTION_DAYS, 365) };
}

export function sha256Of(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * The uploaded Auftrag kept with its tour: stored at preview time, attached when the dispatcher saves the tour.
 * The same file uploaded twice is one row (sha256); an attached document stays with its first tour.
 */
export class OrderDocumentService {
  private readonly options: Required<OrderDocumentOptions>;

  constructor(private readonly db: PrismaClient, options: OrderDocumentOptions = {}) {
    this.options = { ...readDocumentOptions(), ...options };
  }

  async store(input: { buffer: Buffer; filename: string; mimeType: string; previewJson: unknown; customerId?: string | null; actor?: AuditActor }) {
    const sha256 = sha256Of(input.buffer);
    const existing = await this.db.orderDocument.findUnique({ where: { sha256 }, select: DOCUMENT_SELECT });
    if (existing) {
      // A new parse of a still-unattached file replaces the old one; an attached file keeps the parse its tour was made from.
      if (existing.status === 'PENDING') {
        await this.db.orderDocument.update({ where: { id: existing.id }, data: { previewJson: JSON.stringify(input.previewJson), filename: input.filename.slice(0, 300), customerId: input.customerId ?? null, createdAt: new Date() } });
      }
      return { id: existing.id, sha256, reused: true, attachedTourId: existing.tourId };
    }
    const created = await this.db.orderDocument.create({
      data: {
        sha256, filename: input.filename.slice(0, 300), mimeType: input.mimeType, size: input.buffer.length, content: input.buffer,
        previewJson: JSON.stringify(input.previewJson), customerId: input.customerId ?? null, uploadedByDispatcherId: input.actor?.dispatcherId ?? null
      },
      select: { id: true }
    });
    return { id: created.id, sha256, reused: false, attachedTourId: null as string | null };
  }

  /** What the model answered for exactly this file before, with the timings of that reading. */
  async modelAnswerOf(buffer: Buffer) {
    const row = await this.db.orderDocument.findUnique({ where: { sha256: sha256Of(buffer) }, select: { id: true, status: true, previewJson: true } });
    return row ? storedAnswerOf(row) : null;
  }

  /** Links a pending document to the tour made from it. A second call is a no-op; another tour is refused. */
  async attach(input: { documentId: string; tourId: string; vehicleId: string; confirmedJson: unknown; actor?: AuditActor }, now = new Date()) {
    const current = await this.db.orderDocument.findUnique({ where: { id: input.documentId }, select: DOCUMENT_SELECT });
    if (!current) return null;
    if (current.status === 'ATTACHED') {
      if (current.tourId === input.tourId) return current;
      throw Object.assign(new Error('Этот Auftrag уже сохранён в другом туре.'), { statusCode: 409 });
    }
    const updated = await this.db.orderDocument.update({
      where: { id: input.documentId },
      data: { status: 'ATTACHED', tourId: input.tourId, vehicleId: input.vehicleId, attachedAt: now, confirmedJson: JSON.stringify(input.confirmedJson) },
      select: DOCUMENT_SELECT
    });
    await writeAuditLog(this.db, input.actor, { action: 'ORDER_DOCUMENT_ATTACHED', entityType: 'OrderDocument', entityId: updated.id, tourId: input.tourId, vehicleId: input.vehicleId,
      metadata: { filename: updated.filename, size: updated.size } });
    return updated;
  }

  async get(id: string) {
    return this.db.orderDocument.findUnique({ where: { id }, select: { ...DOCUMENT_SELECT, previewJson: true, confirmedJson: true } });
  }

  /** The newest stored parses, for the reading speed card. */
  async recentPreviews(take: number) {
    return this.db.orderDocument.findMany({ orderBy: { createdAt: 'desc' }, take, select: { previewJson: true, createdAt: true } });
  }

  /** The only read that carries the bytes. Null once the retention sweep emptied them. */
  async file(id: string) {
    const row = await this.db.orderDocument.findUnique({ where: { id }, select: { filename: true, mimeType: true, size: true, content: true } });
    if (!row || row.content.length === 0) return null;
    return { filename: row.filename, mimeType: row.mimeType, size: row.size, content: Buffer.from(row.content) };
  }

  async forTour(tourId: string) {
    return this.db.orderDocument.findUnique({ where: { tourId }, select: DOCUMENT_SELECT });
  }

  async listForVehicle(vehicleId: string, limit = 20) {
    return this.db.orderDocument.findMany({ where: { vehicleId, status: 'ATTACHED' }, orderBy: { attachedAt: 'desc' }, take: limit, select: DOCUMENT_SELECT });
  }

  /** Unattached uploads are deleted; old attached files lose their bytes but keep the row and its parse (history stays). */
  async purge(now = new Date(), actor?: AuditActor) {
    const pending = await this.db.orderDocument.deleteMany({ where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - this.options.pendingTtlDays * DAY_MS) } } });
    const stale = await this.db.orderDocument.findMany({
      where: { status: 'ATTACHED', attachedAt: { lt: new Date(now.getTime() - this.options.retentionDays * DAY_MS) }, size: { gt: 0 } },
      select: { id: true }
    });
    for (const row of stale) {
      await this.db.orderDocument.update({ where: { id: row.id }, data: { content: Buffer.alloc(0), size: 0 } });
    }
    const result = { pending: pending.count, emptied: stale.length };
    if (result.pending || result.emptied) {
      await writeAuditLog(this.db, actor, { action: 'ORDER_DOCUMENTS_PURGED', entityType: 'OrderDocument', entityId: 'sweep', metadata: result, createdAt: now });
    }
    return result;
  }

  /** Pending uploads can be discarded by an admin; attached documents are history. */
  async discard(id: string, actor?: AuditActor) {
    const removed = await this.db.orderDocument.deleteMany({ where: { id, status: 'PENDING' } });
    if (removed.count) await writeAuditLog(this.db, actor, { action: 'ORDER_DOCUMENT_DELETED', entityType: 'OrderDocument', entityId: id });
    return removed.count > 0;
  }
}

/** The model answer kept inside a stored preview; null for Excel, old rows and anything unreadable. */
export function storedAnswerOf(row: { id: string; status: string; previewJson: string }) {
  try {
    const preview = JSON.parse(row.previewJson) as { modelAnswer?: unknown; readStats?: unknown } | null;
    const answer = storedModelAnswerOf(preview?.modelAnswer);
    return answer ? { id: row.id, status: row.status, answer, readStats: preview?.readStats } : null;
  } catch {
    return null;
  }
}
