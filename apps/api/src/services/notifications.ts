import type { PrismaClient } from '@prisma/client';
import { prioritize } from './notification-priority.js';
import type { TourService } from './tours.js';

export type DwellSeverity = 'NONE' | 'WARNING' | 'CRITICAL';

type DwellStop = {
  arrivedAt: Date | null;
  completedAt?: Date | null;
  serviceMinMinutes: number;
  serviceMaxMinutes: number;
};

export function calculateDwellState(stop: DwellStop | null | undefined, now = new Date()): {
  dwellMinutes: number | null;
  dwellSeverity: DwellSeverity;
} {
  if (!stop?.arrivedAt || stop.completedAt) return { dwellMinutes: null, dwellSeverity: 'NONE' };

  const dwellMinutes = Math.max(0, Math.floor((now.getTime() - stop.arrivedAt.getTime()) / 60_000));
  if (now.getTime() - stop.arrivedAt.getTime() > stop.serviceMaxMinutes * 60_000) {
    return { dwellMinutes, dwellSeverity: 'CRITICAL' };
  }
  if (now.getTime() - stop.arrivedAt.getTime() > stop.serviceMinMinutes * 60_000) {
    return { dwellMinutes, dwellSeverity: 'WARNING' };
  }
  return { dwellMinutes, dwellSeverity: 'NONE' };
}

/** Durable notifications, not browser timers: missed arrivals survive app restarts. */
export class NotificationService {
  constructor(private readonly db: PrismaClient, private readonly tours: TourService,
    private readonly restingAt: (vehicleId: string, stopId: string) => boolean = () => false) {}

  async refresh(now = new Date()) {
    const vehicles = await this.db.vehicle.findMany({
      where: { tours: { some: { status: 'ACTIVE' } } },
      include: { tours: { where: { status: 'ACTIVE' }, include: { stops: { orderBy: { sequence: 'asc' } } } } }
    });
    for (const vehicle of vehicles) {
      const stop = vehicle.tours[0]?.stops.find(item => !item.completedAt);
      if (!stop || this.restingAt(vehicle.id, stop.id)) continue;
      // Arrival comes only from the GPS zone; a calculated position never raises an arrival prompt.
      const dwell = calculateDwellState(stop, now);
      if (dwell.dwellSeverity !== 'NONE') {
        const dedupKey = `dwell:${stop.id}`;
        const existing = await this.db.notification.findUnique({ where: { dedupKey } });
        const previousSeverity = existing ? getPayloadSeverity(existing.payloadJson) : null;
        await this.publish({
          dedupKey, vehicleId: vehicle.id, stopId: stop.id, type: 'LONG_DWELL',
          message: dwell.dwellSeverity === 'CRITICAL'
            ? `Грузовик ${vehicle.vehicleNumber}: критическая стоянка в ${stop.city || stop.address} — более ${stop.serviceMaxMinutes} минут.`
            : `Грузовик ${vehicle.vehicleNumber}: стоянка в ${stop.city || stop.address} превысила ${stop.serviceMinMinutes} минут.`,
          payload: {
            arrivedAt: stop.arrivedAt,
            serviceMinMinutes: stop.serviceMinMinutes,
            serviceMaxMinutes: stop.serviceMaxMinutes,
            dwellMinutes: dwell.dwellMinutes,
            severity: dwell.dwellSeverity
          }
        }, previousSeverity !== null && previousSeverity !== dwell.dwellSeverity);
      }
    }
  }

  async publish(input: { dedupKey: string; vehicleId: string; stopId?: string; type: string; message: string; payload: unknown }, reopen = false) {
    const { payload, ...data } = input;
    return this.db.notification.upsert({
      where: { dedupKey: input.dedupKey },
      create: { ...data, payloadJson: JSON.stringify(payload) },
      update: {
        message: input.message,
        payloadJson: JSON.stringify(payload),
        ...(reopen ? { acknowledgedAt: null } : {})
      }
    });
  }

  /** Open notifications, most important first: decisions, then risks, then information and what no longer applies. */
  async list(now = new Date()) {
    const items = await this.db.notification.findMany({ where: { acknowledgedAt: null }, orderBy: { createdAt: 'asc' }, take: 300 });
    const legIds = new Set<string>();
    const stopIds = new Set<string>();
    for (const item of items) {
      if (item.stopId) stopIds.add(item.stopId);
      const payload = parsePayload(item.payloadJson);
      if (typeof payload.legId === 'string') legIds.add(payload.legId);
      if (typeof payload.openStopId === 'string') stopIds.add(payload.openStopId);
    }
    const legs = legIds.size ? await this.db.leg.findMany({ where: { id: { in: [...legIds] } }, select: { id: true, toStopId: true } }) : [];
    for (const leg of legs) stopIds.add(leg.toStopId);
    const stops = stopIds.size ? await this.db.stop.findMany({ where: { id: { in: [...stopIds] } },
      select: { id: true, type: true, arrivedAt: true, completedAt: true, appointmentAt: true, appointmentWindowStartAt: true } }) : [];
    return prioritize(items, { stops: new Map(stops.map((stop) => [stop.id, stop])), legTarget: new Map(legs.map((leg) => [leg.id, leg.toStopId])) }, now);
  }

  acknowledge(id: string, now = new Date()) {
    return this.db.notification.updateMany({ where: { id, acknowledgedAt: null }, data: { acknowledgedAt: now } });
  }

  acknowledgeMany(ids: string[], now = new Date()) {
    return this.db.notification.updateMany({ where: { id: { in: ids }, acknowledgedAt: null }, data: { acknowledgedAt: now } });
  }
}

function getPayloadSeverity(payloadJson: string): DwellSeverity | null {
  try {
    const payload = JSON.parse(payloadJson) as { severity?: unknown };
    return payload.severity === 'WARNING' || payload.severity === 'CRITICAL' ? payload.severity : null;
  } catch {
    return null;
  }
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(payloadJson);
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
