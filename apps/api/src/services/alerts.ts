import type { PrismaClient } from "@prisma/client";
import type { ScheduleStop } from "./eta.js";

type AlertType = "TWO_HOURS" | "ONE_HOUR";

export class AlertService {
  constructor(private readonly db: PrismaClient) {}

  async refreshVehicleAlerts(vehicleId: string, schedule: ScheduleStop[], now = new Date()) {
    const candidates = schedule.flatMap((item) => {
      if (!item.appointmentAt || item.predictedDelayMinutes <= 0) return [];

      const minutesToAppointment = (item.appointmentAt.getTime() - now.getTime()) / 60_000;
      const type = getAlertType(minutesToAppointment);
      return type ? [{ item, type }] : [];
    });
    const activeKeys = new Set(candidates.map(({ item, type }) => `${item.stopId}:${type}`));
    const openAlerts = await this.db.alert.findMany({
      where: { vehicleId, resolvedAt: null },
      select: { id: true, stopId: true, type: true }
    });
    const obsoleteAlertIds = openAlerts
      .filter((alert) => !activeKeys.has(`${alert.stopId}:${alert.type}`))
      .map((alert) => alert.id);

    if (obsoleteAlertIds.length > 0) {
      await this.db.alert.updateMany({
        where: { id: { in: obsoleteAlertIds } },
        data: { resolvedAt: now }
      });
    }

    const created = [];

    for (const { item, type } of candidates) {
      const alert = await this.db.alert.upsert({
        where: { stopId_type: { stopId: item.stopId, type } },
        create: {
          vehicleId,
          tourId: item.tourId,
          stopId: item.stopId,
          type,
          appointmentAt: item.appointmentAt!,
          predictedEta: item.predictedEta,
          predictedLateMinutes: item.predictedDelayMinutes
        },
        update: {
          appointmentAt: item.appointmentAt!,
          predictedEta: item.predictedEta,
          predictedLateMinutes: item.predictedDelayMinutes,
          resolvedAt: null
        }
      });
      created.push(alert);
    }

    return created;
  }
}

function getAlertType(minutesToAppointment: number): AlertType | null {
  if (minutesToAppointment <= 60) return "ONE_HOUR";
  if (minutesToAppointment <= 120) return "TWO_HOURS";
  return null;
}
