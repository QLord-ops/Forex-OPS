import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import type { AuditActor } from './audit-log.js';

export const CUSTOMER_NOTICE_EVENT = 'CUSTOMER_NOTIFIED';

/**
 * «Сообщить заказчику» (owner, 18.11.2026): the dispatcher sends the delay letter from their own mail program; OPS only
 * records that the customer was told, when, by whom and with which ETA. No letter leaves the server.
 */
export const customerNoticeInput = z.object({
  tourId: z.string().trim().min(1).max(64),
  stopId: z.string().trim().min(1).max(64),
  channel: z.enum(['EMAIL', 'COPY']),
  etaAt: z.string().datetime().nullable().optional(),
  delayMinutes: z.number().int().min(-10_000).max(10_000).nullable().optional(),
  recipients: z.number().int().min(0).max(20)
}).strict();
export type CustomerNoticeInput = z.infer<typeof customerNoticeInput>;

export type CustomerNotice = { at: string; by: string; channel: 'EMAIL' | 'COPY'; stopId: string; etaAt: string | null; delayMinutes: number | null };

export class CustomerNoticeError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

type Payload = { stopId?: unknown; channel?: unknown; etaAt?: unknown; delayMinutes?: unknown; by?: unknown };

function toNotice(event: { createdAt: Date; payloadJson: string; stopId: string | null }): CustomerNotice | null {
  let payload: Payload;
  try { payload = JSON.parse(event.payloadJson) as Payload; } catch { return null; }
  const stopId = typeof payload.stopId === 'string' ? payload.stopId : event.stopId;
  if (!stopId) return null;
  return {
    at: event.createdAt.toISOString(),
    by: typeof payload.by === 'string' && payload.by ? payload.by : 'диспетчер',
    channel: payload.channel === 'COPY' ? 'COPY' : 'EMAIL',
    stopId,
    etaAt: typeof payload.etaAt === 'string' ? payload.etaAt : null,
    delayMinutes: typeof payload.delayMinutes === 'number' ? payload.delayMinutes : null
  };
}

export class CustomerNotices {
  constructor(private readonly db: PrismaClient) {}

  async record(vehicleId: string, input: CustomerNoticeInput, actor: AuditActor | undefined, now = new Date()): Promise<CustomerNotice> {
    const tour = await this.db.tour.findUnique({ where: { id: input.tourId }, select: { id: true, vehicleId: true, status: true, stops: { select: { id: true, completedAt: true } } } });
    if (!tour || tour.vehicleId !== vehicleId) throw new CustomerNoticeError('Тур не найден у этой машины.', 404);
    const stop = tour.stops.find((item) => item.id === input.stopId);
    if (!stop) throw new CustomerNoticeError('Точка не найдена в этом туре.', 404);
    if (stop.completedAt) throw new CustomerNoticeError('Точка уже завершена: сообщать заказчику о ней нечего.', 409);
    const by = await this.nameOf(actor);
    const payload = { stopId: stop.id, channel: input.channel, etaAt: input.etaAt ?? null, delayMinutes: input.delayMinutes ?? null, recipients: input.recipients, by };
    const event = await this.db.operationEvent.create({
      data: { vehicleId, tourId: tour.id, stopId: stop.id, type: CUSTOMER_NOTICE_EVENT, payloadJson: JSON.stringify(payload), createdAt: now }
    });
    return toNotice(event)!;
  }

  /** The latest notice of each tour, for the dashboard: one query for the whole fleet. */
  async latestByTour(tourIds: string[]): Promise<Map<string, CustomerNotice>> {
    const result = new Map<string, CustomerNotice>();
    if (!tourIds.length) return result;
    const events = await this.db.operationEvent.findMany({
      where: { type: CUSTOMER_NOTICE_EVENT, tourId: { in: tourIds } },
      orderBy: { createdAt: 'desc' },
      select: { tourId: true, stopId: true, createdAt: true, payloadJson: true }
    });
    for (const event of events) {
      if (!event.tourId || result.has(event.tourId)) continue;
      const notice = toNotice(event);
      if (notice) result.set(event.tourId, notice);
    }
    return result;
  }

  private async nameOf(actor: AuditActor | undefined): Promise<string> {
    if (!actor?.dispatcherId) return actor?.role === 'admin' ? 'администратор' : 'диспетчер';
    const dispatcher = await this.db.dispatcher.findUnique({ where: { id: actor.dispatcherId }, select: { displayName: true } });
    return dispatcher?.displayName ?? 'диспетчер';
  }
}
