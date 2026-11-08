import type { PrismaClient } from '@prisma/client';
import { writeAuditLog, type AuditActor } from './audit-log.js';

const DAY_MS = 86_400_000;
export const DEFAULT_TELEMETRY_RETENTION_DAYS = 5;

export const TELEMETRY_SYSTEM_ACTOR: AuditActor = { role: 'system', sessionId: 'telemetry-retention' };

/**
 * Days of GPS kept in OPS. The app itself reads at most the last 12 hours (arrival, departure, the previous tour);
 * the full trip history stays with Webfleet. Fewer stored positions also follows DSGVO (CLAUDE.md rule 8).
 */
export function telemetryRetentionDays(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.TELEMETRY_RETENTION_DAYS);
  return Number.isInteger(value) && value >= 1 && value <= 3650 ? value : DEFAULT_TELEMETRY_RETENTION_DAYS;
}

type Options = { days?: number; batch?: number; maxBatches?: number; pause?: (ms: number) => Promise<void> };

export class TelemetryRetention {
  private readonly days: number;
  private readonly batch: number;
  // One run deletes at most batch × maxBatches rows with short pauses, so the first cleanup of a big table does not load the database at once.
  private readonly maxBatches: number;
  private readonly pause: (ms: number) => Promise<void>;

  constructor(private readonly db: PrismaClient, options: Options = {}) {
    this.days = options.days ?? telemetryRetentionDays();
    this.batch = options.batch ?? 2_000;
    this.maxBatches = options.maxBatches ?? 250;
    this.pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** GPS rows older than the retention go, truck by truck along the (vehicleId, recordedAt) index; the newest row of every truck stays. */
  async purge(now = new Date(), actor?: AuditActor) {
    const cutoff = new Date(now.getTime() - this.days * DAY_MS);
    const vehicles = await this.db.vehicle.findMany({ select: { id: true } });
    let deleted = 0;
    let batches = 0;
    let more = false;
    for (const { id: vehicleId } of vehicles) {
      const newest = await this.db.vehicleTelemetry.findFirst({ where: { vehicleId }, orderBy: { recordedAt: 'desc' }, select: { id: true } });
      if (!newest) continue;
      for (;;) {
        if (batches >= this.maxBatches) { more = true; break; }
        const rows = await this.db.vehicleTelemetry.findMany({
          where: { vehicleId, recordedAt: { lt: cutoff }, id: { not: newest.id } },
          orderBy: { recordedAt: 'asc' }, take: this.batch, select: { id: true }
        });
        if (!rows.length) break;
        deleted += (await this.db.vehicleTelemetry.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })).count;
        batches += 1;
        if (rows.length < this.batch) break;
        await this.pause(100);
      }
      if (more) break;
    }
    if (deleted) {
      await writeAuditLog(this.db, actor, { action: 'TELEMETRY_PURGED', entityType: 'VehicleTelemetry', entityId: 'sweep',
        metadata: { deleted, retentionDays: this.days, before: cutoff.toISOString(), more }, createdAt: now });
    }
    return { deleted, more };
  }
}
