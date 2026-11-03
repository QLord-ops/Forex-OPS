import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import { appointmentTime, matchAppointment, type AppointmentMatch } from './appointment-match.js';
import type { AppointmentDocument } from './pdf-order-import.js';
import { normalizePlate } from './webfleet.js';

const DAY_MS = 24 * 3600_000;

export function documentFingerprint(buffer: Buffer) {
  return `termin-${createHash('sha256').update(buffer).digest('hex')}`;
}

type PendingRow = Awaited<ReturnType<PrismaClient['pendingAppointment']['findFirstOrThrow']>>;

/** A stored row back in the shape the matcher reads. Times go back to Berlin wall-clock text. */
export function pendingToDocument(row: PendingRow): AppointmentDocument {
  let references: AppointmentDocument['references'] = [];
  try { const value: unknown = JSON.parse(row.referencesJson ?? '[]'); if (Array.isArray(value)) references = value.filter((item): item is { label: string; value: string } => typeof item?.value === 'string'); } catch { /* keep empty */ }
  return {
    kind: row.documentKind as AppointmentDocument['kind'], documentType: null, plate: row.vehiclePlate, trailerPlate: null,
    company: row.company, site: row.site, city: row.city, stopType: row.stopType as AppointmentDocument['stopType'],
    appointmentLocal: berlinLocal(row.appointmentAt), windowStartLocal: berlinLocal(row.windowStartAt), windowEndLocal: berlinLocal(row.windowEndAt),
    standgeldFromLocal: null, references, positions: [], sourceExcerpt: row.sourceExcerpt, confidence: 1, warnings: []
  };
}

function berlinLocal(at: Date | null) {
  if (!at) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(at).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export class PendingAppointmentService {
  constructor(private readonly db: PrismaClient) {}

  /** The same file again: whether it was already applied or is waiting. */
  async findByFingerprint(fingerprint: string) {
    return this.db.pendingAppointment.findUnique({ where: { fingerprint } });
  }

  async save(document: AppointmentDocument, fingerprint: string, status: 'PENDING' | 'ATTACHED', extra: { vehicleId?: string | null; attachedStopId?: string | null; dispatcherId?: string | null } = {}) {
    const time = appointmentTime(document);
    const data = {
      documentKind: document.kind, vehiclePlate: normalizePlate(document.plate ?? document.trailerPlate) || null, vehicleId: extra.vehicleId ?? null,
      company: document.company?.slice(0, 300) ?? null, site: document.site?.slice(0, 300) ?? null, city: document.city?.slice(0, 200) ?? null,
      stopType: document.stopType, appointmentAt: time.appointmentAt, windowStartAt: time.windowStartAt, windowEndAt: time.windowEndAt,
      referencesJson: JSON.stringify(document.references.slice(0, 15)), sourceExcerpt: document.sourceExcerpt?.slice(0, 1000) ?? null,
      status, attachedStopId: extra.attachedStopId ?? null, createdByDispatcherId: extra.dispatcherId ?? null
    };
    return this.db.pendingAppointment.upsert({ where: { fingerprint }, create: { fingerprint, ...data }, update: status === 'ATTACHED' ? { status, attachedStopId: data.attachedStopId } : {} });
  }

  /** Waiting slips with their best stop right now. A slip whose day has passed expires; the row stays. */
  async list(now = new Date()) {
    await this.db.pendingAppointment.updateMany({
      where: { status: 'PENDING', OR: [{ appointmentAt: { lt: new Date(now.getTime() - DAY_MS) } }, { appointmentAt: null, windowEndAt: { lt: new Date(now.getTime() - DAY_MS) } }] },
      data: { status: 'EXPIRED' }
    });
    const rows = await this.db.pendingAppointment.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 50 });
    return Promise.all(rows.map(async (row) => ({ ...serialize(row), match: await matchAppointment(this.db, pendingToDocument(row)) })));
  }

  async dismiss(id: string) {
    const changed = await this.db.pendingAppointment.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'DISMISSED' } });
    if (!changed.count) throw Object.assign(new Error('Термин уже привязан или отклонён.'), { statusCode: 409 });
    return { ok: true };
  }

  async attach(id: string, stopId: string) {
    await this.db.pendingAppointment.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'ATTACHED', attachedStopId: stopId } });
  }

  /**
   * After new tours arrive, a waiting slip may now have its stop: the dispatcher gets a notification
   * and still confirms the change in the review card.
   */
  async scan(publish: (input: { dedupKey: string; vehicleId: string; stopId: string; type: string; message: string; payload: unknown }) => Promise<unknown>, now = new Date()) {
    const pending = await this.list(now);
    for (const row of pending) {
      const best = foundStop(row.match);
      if (!best) continue;
      const place = [row.company, row.city].filter(Boolean).join(', ') || 'точка';
      const when = row.appointmentAt ?? row.windowStartAt;
      await publish({
        dedupKey: `appointment-match:${row.id}:${best.stopId}`, vehicleId: best.vehicleId, stopId: best.stopId, type: 'APPOINTMENT_MATCH',
        message: `Для LKW ${best.vehicleNumber} есть термин: ${place}${when ? `, ${berlinLocal(new Date(when))?.replace('T', ' ')}` : ''}. Проверьте и привяжите.`,
        payload: { pendingId: row.id, stopId: best.stopId }
      });
    }
  }
}

function foundStop(match: AppointmentMatch) {
  return match.status === 'MATCHED' ? match.candidates[0] : null;
}

function serialize(row: PendingRow) {
  let references: unknown = [];
  try { references = JSON.parse(row.referencesJson ?? '[]'); } catch { /* keep empty */ }
  return {
    id: row.id, fingerprint: row.fingerprint, documentKind: row.documentKind, vehiclePlate: row.vehiclePlate, company: row.company, site: row.site, city: row.city, stopType: row.stopType,
    appointmentAt: row.appointmentAt?.toISOString() ?? null, windowStartAt: row.windowStartAt?.toISOString() ?? null, windowEndAt: row.windowEndAt?.toISOString() ?? null,
    references, sourceExcerpt: row.sourceExcerpt, createdAt: row.createdAt.toISOString()
  };
}
