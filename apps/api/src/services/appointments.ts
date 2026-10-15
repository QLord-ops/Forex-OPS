import type { PrismaClient } from "@prisma/client";
import type { CurrentPosition } from "../domain.js";
import { EtaService } from "./eta.js";
import { TourPlanConflictError } from "./tours.js";

export type AppointmentRisk = "ON_TIME" | "RISK" | "LATE" | "UNKNOWN";
export type AppointmentAction = "LEAVE_BY" | "LEAVE_NOW" | "IN_TRANSIT" | "ARRIVED" | "UNKNOWN_POSITION";

export interface AppointmentAnalysis {
  stopId: string;
  tourId: string;
  vehicleId: string;
  version: number;
  generatedAt: string;
  appointmentAt: string;
  previousAppointmentAt: string | null;
  earliestArrival: string | null;
  latestArrival: string | null;
  recommendedStartAt: string | null;
  bufferMinutes: number | null;
  risk: AppointmentRisk;
  action: AppointmentAction;
  message: string;
  preliminary: boolean;
}

type AppointmentInput = { appointmentAt: string; version?: number };

export class AppointmentService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eta = new EtaService(),
    private readonly getPosition?: (vehicleId: string, now: Date) => Promise<CurrentPosition>
  ) {}

  async preview(stopId: string, input: AppointmentInput, now = new Date()): Promise<AppointmentAnalysis> {
    const appointmentAt = parseAppointment(input.appointmentAt);
    const context = await this.readContext(stopId);
    assertEditableStop(context.stop.completedAt, context.stop.tour.status);

    const tours = context.vehicle.tours.map((tour) => ({
      ...tour,
      vehicle: context.vehicle,
      stops: tour.stops.map((stop) => stop.id === stopId ? { ...stop, appointmentAt } : stop)
    }));
    const schedule = this.eta.calculateVehicleSchedule(tours, now);
    const target = schedule.find((item) => item.stopId === stopId);
    if (!target) throw new TourPlanConflictError("Точка больше не входит в актуальный маршрут машины.");

    const position = this.getPosition ? await this.getPosition(context.vehicle.id, now) : null;
    const targetTour = context.vehicle.tours.find((tour) => tour.id === context.stop.tourId)!;
    const approachLeg = targetTour.legs.find((leg) => leg.toStopId === stopId && leg.status !== "COMPLETED");
    const unknownStartPosition = !target.earliestArrival || !target.latestArrival;
    const movingToTarget = Boolean(position?.legId && approachLeg?.id === position.legId && position.status === "MOVING");
    const earliestArrival = target.earliestArrival;
    const latestArrival = target.latestArrival;
    const bufferMinutes = latestArrival
      ? Math.floor((appointmentAt.getTime() - latestArrival.getTime()) / 60_000)
      : null;

    let risk: AppointmentRisk = !earliestArrival || !latestArrival
      ? "UNKNOWN"
      : earliestArrival > appointmentAt
      ? "LATE"
      : latestArrival > appointmentAt
        ? "RISK"
        : "ON_TIME";
    let action: AppointmentAction;
    let recommendedStartAt: Date | null = latestArrival ? new Date(
      appointmentAt.getTime() - Math.max(0, latestArrival.getTime() - now.getTime())
    ) : null;
    let message: string;

    if (context.stop.arrivedAt) {
      action = "ARRIVED";
      recommendedStartAt = null;
      message = "Прибытие на точку уже подтверждено; термин сохранится для контроля времени на точке.";
    } else if (unknownStartPosition) {
      action = "UNKNOWN_POSITION";
      recommendedStartAt = null;
      risk = "UNKNOWN";
      message = "Для расчёта выезда к первой точке нужна актуальная позиция машины. ETA остаётся предварительной.";
    } else if (movingToTarget) {
      action = "IN_TRANSIT";
      recommendedStartAt = null;
      message = risk === "LATE"
        ? "Машина уже в пути, но даже ранняя ETA позже термина. Нужна связь с точкой или изменение маршрута."
        : risk === "RISK"
          ? "Машина уже в пути; верхняя граница ETA позже термина. Контролируйте пробки и остановки."
          : "Машина уже в пути и текущий расчёт позволяет прибыть вовремя.";
    } else if (recommendedStartAt && recommendedStartAt <= now) {
      action = "LEAVE_NOW";
      message = risk === "LATE"
        ? "Расчёт уже показывает опоздание. Выезжать нужно немедленно и согласовать новый термин."
        : "Чтобы сохранить рассчитанный запас, начинать движение нужно сейчас.";
    } else if (recommendedStartAt) {
      action = "LEAVE_BY";
      message = `Рекомендуемое начало движения — не позднее ${recommendedStartAt.toISOString()}.`;
    } else {
      action = "UNKNOWN_POSITION";
      risk = "UNKNOWN";
      message = "Для расчёта времени выезда недостаточно данных о маршруте.";
    }

    return {
      stopId,
      tourId: context.stop.tourId,
      vehicleId: context.vehicle.id,
      version: context.stop.tour.planVersion,
      generatedAt: now.toISOString(),
      appointmentAt: appointmentAt.toISOString(),
      previousAppointmentAt: context.stop.appointmentAt?.toISOString() ?? null,
      earliestArrival: earliestArrival?.toISOString() ?? null,
      latestArrival: latestArrival?.toISOString() ?? null,
      recommendedStartAt: recommendedStartAt?.toISOString() ?? null,
      bufferMinutes,
      risk,
      action,
      message,
      preliminary: target.preliminary || risk === "UNKNOWN"
    };
  }

  async apply(stopId: string, input: Required<AppointmentInput>, now = new Date()): Promise<AppointmentAnalysis> {
    const appointmentAt = parseAppointment(input.appointmentAt);
    const decision = await this.preview(stopId, { appointmentAt: appointmentAt.toISOString() }, now);
    if (decision.version !== input.version) {
      throw new TourPlanConflictError("Маршрут изменился. Обновите данные и рассчитайте термин повторно.");
    }
    const context = await this.readContext(stopId);
    assertEditableStop(context.stop.completedAt, context.stop.tour.status);

    await this.db.$transaction(async (tx) => {
      const changedTour = await tx.tour.updateMany({
        where: {
          id: context.stop.tourId,
          planVersion: input.version,
          status: { in: ["ACTIVE", "QUEUED"] }
        },
        data: {
          planVersion: { increment: 1 },
        }
      });
      if (!changedTour.count) throw new TourPlanConflictError("Маршрут изменился. Обновите данные и рассчитайте термин повторно.");

      const changedStop = await tx.stop.updateMany({
        where: { id: stopId, completedAt: null },
        data: { appointmentAt }
      });
      if (!changedStop.count) throw new TourPlanConflictError("Точка уже завершена или была изменена.");

      await tx.operationEvent.create({
        data: {
          vehicleId: context.vehicle.id,
          tourId: context.stop.tourId,
          stopId,
          type: "APPOINTMENT_ATTACHED",
          reason: decision.recommendedStartAt
            ? `Термин прикреплён. Начать движение не позднее ${decision.recommendedStartAt}.`
            : `Термин прикреплён. ${decision.message}`,
          payloadJson: JSON.stringify({
            previousAppointmentAt: context.stop.appointmentAt?.toISOString() ?? null,
            appointmentAt: appointmentAt.toISOString(),
            appliedAt: now.toISOString(),
            earliestArrival: decision.earliestArrival,
            latestArrival: decision.latestArrival,
            recommendedStartAt: decision.recommendedStartAt,
            bufferMinutes: decision.bufferMinutes,
            risk: decision.risk,
            action: decision.action,
            preliminary: decision.preliminary
          })
        }
      });
    });

    return this.preview(stopId, { appointmentAt: appointmentAt.toISOString() }, now);
  }

  private async readContext(stopId: string) {
    const stop = await this.db.stop.findUniqueOrThrow({ where: { id: stopId }, include: { tour: true } });
    const vehicle = await this.db.vehicle.findUniqueOrThrow({
      where: { id: stop.tour.vehicleId },
      include: {
        tours: {
          where: { status: { in: ["ACTIVE", "QUEUED"] } },
          include: {
            stops: { orderBy: { sequence: "asc" } },
            legs: { orderBy: { createdAt: "asc" } }
          },
          orderBy: [{ queueIndex: "asc" }, { plannedStartAt: "asc" }, { createdAt: "asc" }]
        }
      }
    });
    return { stop, vehicle };
  }
}

function parseAppointment(value: string): Date {
  const appointmentAt = new Date(value);
  if (!value || Number.isNaN(appointmentAt.getTime())) {
    throw new TourPlanConflictError("Укажите корректные дату и время термина.");
  }
  return appointmentAt;
}

function assertEditableStop(completedAt: Date | null, tourStatus: string): void {
  if (completedAt || !["ACTIVE", "QUEUED"].includes(tourStatus)) {
    throw new TourPlanConflictError("Термин можно добавить только к незавершённой точке актуального или ожидающего заказа.");
  }
}
