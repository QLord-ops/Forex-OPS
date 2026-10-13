import type { PrismaClient } from '@prisma/client';
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
  constructor(private readonly db: PrismaClient, private readonly tours: TourService) {}

  async refresh(now = new Date()) {
    const vehicles = await this.db.vehicle.findMany({
      where: { tours: { some: { status: 'ACTIVE' } } },
      include: { tours: { where: { status: 'ACTIVE' }, include: { stops: { orderBy: { sequence: 'asc' } } } } }
    });
    for (const vehicle of vehicles) {
      const stop = vehicle.tours[0]?.stops.find(item => !item.completedAt);
      if (!stop) continue;
      const position = await this.tours.getCurrentPosition(vehicle.id, now);
      if (!stop.arrivedAt && position.status === 'ARRIVED') {
        await this.publish({
          dedupKey: `arrival:${stop.id}`, vehicleId: vehicle.id, stopId: stop.id,
          type: 'PREDICTED_ARRIVAL',
          message: `Грузовик ${vehicle.vehicleNumber}, вероятно, прибыл ${stop.type === 'LOAD' ? 'на загрузку' : 'на выгрузку'}, ${stop.city || 'город неизвестен'}`,
          payload: { vehicleNumber: vehicle.vehicleNumber, city: stop.city, stopType: stop.type, address: stop.address }
        });
      }
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

  list() {
    return this.db.notification.findMany({ where: { acknowledgedAt: null }, orderBy: { createdAt: 'asc' }, take: 100 });
  }

  acknowledge(id: string, now = new Date()) {
    return this.db.notification.updateMany({ where: { id, acknowledgedAt: null }, data: { acknowledgedAt: now } });
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
