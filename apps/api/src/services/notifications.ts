import type { PrismaClient } from '@prisma/client';
import type { TourService } from './tours.js';

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
      if (stop.arrivedAt && now.getTime() - stop.arrivedAt.getTime() > stop.serviceMaxMinutes * 60_000) {
        await this.publish({
          dedupKey: `dwell:${stop.id}`, vehicleId: vehicle.id, stopId: stop.id, type: 'LONG_DWELL',
          message: `Грузовик ${vehicle.vehicleNumber}: превышено плановое время стоянки в ${stop.city || stop.address}.`,
          payload: { arrivedAt: stop.arrivedAt, serviceMaxMinutes: stop.serviceMaxMinutes }
        });
      }
    }
  }

  async publish(input: { dedupKey: string; vehicleId: string; stopId?: string; type: string; message: string; payload: unknown }) {
    const { payload, ...data } = input;
    return this.db.notification.upsert({
      where: { dedupKey: input.dedupKey },
      create: { ...data, payloadJson: JSON.stringify(payload) }, update: {}
    });
  }

  list() {
    return this.db.notification.findMany({ where: { acknowledgedAt: null }, orderBy: { createdAt: 'asc' }, take: 100 });
  }

  acknowledge(id: string, now = new Date()) {
    return this.db.notification.updateMany({ where: { id, acknowledgedAt: null }, data: { acknowledgedAt: now } });
  }
}
