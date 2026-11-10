import type { PrismaClient } from "@prisma/client";
import type { CurrentPosition } from "../domain.js";
import { EtaService } from "./eta.js";
import { hasTermin, isTerminFollower, terminFollowerIds, terminLeadIndex } from "./termin-groups.js";
import { TourPlanConflictError } from "./tours.js";

export type AppointmentRisk = "ON_TIME" | "RISK" | "LATE" | "UNKNOWN";
export type AppointmentAction = "LEAVE_BY" | "LEAVE_NOW" | "IN_TRANSIT" | "ARRIVED" | "UNKNOWN_POSITION";

/** PLACE: the Termin of the whole place, kept on its first stop. STOP: a Termin of this stop only. */
export type AppointmentScope = "PLACE" | "STOP";

export interface AppointmentAnalysis {
  /** The stop the Termin is kept on; it differs from the requested one when the place has an earlier stop. */
  stopId: string;
  requestedStopId: string;
  appliedToStopId: string;
  /** Later stops of the same place that are served under this Termin. */
  sharedStopIds: string[];
  /** Set when the Termin covers several stops of one place: their numbers in the tour, the first keeps the Termin. */
  sharedPlace: { sequences: number[]; city: string | null } | null;
  tourId: string;
  vehicleId: string;
  version: number;
  generatedAt: string;
  /** The deadline the ETA is checked against: the exact time, or the end of the window. */
  appointmentAt: string;
  windowStartAt: string | null;
  windowEndAt: string | null;
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

/** Either an exact time or a window; the other form is cleared when it is applied. */
type AppointmentInput = { appointmentAt?: string | null; windowStartAt?: string | null; windowEndAt?: string | null; version?: number };
export type AppointmentApplyOptions = {
  /** References printed on the slip (Fahrt-ID, Borderonummer); added to the stop without duplicates. */
  references?: string[];
  source?: "DISPATCHER" | "DOCUMENT";
  document?: { kind: string; label: string | null };
  scope?: AppointmentScope;
};

export class AppointmentService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eta = new EtaService(),
    private readonly getPosition?: (vehicleId: string, now: Date) => Promise<CurrentPosition>
  ) {}

  async preview(requestedStopId: string, input: AppointmentInput, now = new Date(), scope: AppointmentScope = "PLACE"): Promise<AppointmentAnalysis> {
    const slot = parseSlot(input);
    const appointmentAt = slot.deadline;
    const { stopId, sharedStopIds, sharedPlace } = await this.terminTarget(requestedStopId, scope);
    const context = await this.readContext(stopId);
    assertEditableStop(context.stop.completedAt, context.stop.tour.status);

    const tours = context.vehicle.tours.map((tour) => ({
      ...tour,
      vehicle: context.vehicle,
      stops: tour.stops.map((stop) => stop.id === stopId
        ? { ...stop, appointmentAt: slot.appointmentAt, appointmentWindowStartAt: slot.windowStartAt, appointmentWindowEndAt: slot.windowEndAt }
        : stop)
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
      requestedStopId,
      appliedToStopId: stopId,
      sharedStopIds,
      sharedPlace,
      tourId: context.stop.tourId,
      vehicleId: context.vehicle.id,
      version: context.stop.tour.planVersion,
      generatedAt: now.toISOString(),
      appointmentAt: appointmentAt.toISOString(),
      windowStartAt: slot.windowStartAt?.toISOString() ?? null,
      windowEndAt: slot.windowEndAt?.toISOString() ?? null,
      previousAppointmentAt: (context.stop.appointmentAt ?? context.stop.appointmentWindowEndAt)?.toISOString() ?? null,
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

  async apply(requestedStopId: string, input: AppointmentInput & { version: number }, now = new Date(), options: AppointmentApplyOptions = {}): Promise<AppointmentAnalysis> {
    const slot = parseSlot(input);
    const slotInput = { appointmentAt: slot.appointmentAt?.toISOString() ?? null, windowStartAt: slot.windowStartAt?.toISOString() ?? null, windowEndAt: slot.windowEndAt?.toISOString() ?? null };
    const decision = await this.preview(requestedStopId, slotInput, now, options.scope);
    const stopId = decision.appliedToStopId;
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

      const references = mergeReferences(context.stop.referenceNumbersJson, options.references ?? []);
      const changedStop = await tx.stop.updateMany({
        where: { id: stopId, completedAt: null },
        // One form only: an exact time clears the window and a window clears the exact time.
        data: { appointmentAt: slot.appointmentAt, appointmentWindowStartAt: slot.windowStartAt, appointmentWindowEndAt: slot.windowEndAt,
          ...(references !== null ? { referenceNumbersJson: references } : {}) }
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
            previousWindow: context.stop.appointmentWindowStartAt ? [context.stop.appointmentWindowStartAt.toISOString(), context.stop.appointmentWindowEndAt?.toISOString() ?? null] : null,
            appointmentAt: slotInput.appointmentAt,
            windowStartAt: slotInput.windowStartAt,
            windowEndAt: slotInput.windowEndAt,
            source: options.source ?? "DISPATCHER",
            requestedStopId,
            sharedStopIds: decision.sharedStopIds,
            document: options.document ?? null,
            addedReferences: options.references ?? [],
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

    return { ...await this.preview(stopId, slotInput, now, "STOP"), requestedStopId, sharedStopIds: decision.sharedStopIds, sharedPlace: decision.sharedPlace };
  }

  /**
   * Unloading and loading at one plant share one Termin, kept on the first open stop of the place: a Termin given
   * for the later stop is stored there. A stop that already has its own Termin keeps it for itself. Scope STOP gives
   * the later stop a Termin of its own only next to the Termin of the place: without one it would be the place's.
   */
  private async terminTarget(stopId: string, scope: AppointmentScope): Promise<Pick<AppointmentAnalysis, "stopId" | "sharedStopIds" | "sharedPlace">> {
    const stop = await this.db.stop.findUniqueOrThrow({ where: { id: stopId }, include: { tour: { include: { stops: { orderBy: { sequence: "asc" } } } } } });
    const stops = stop.tour.stops;
    const index = stops.findIndex((item) => item.id === stopId);
    let lead = isTerminFollower(stops, index) ? terminLeadIndex(stops, index) : index;
    // History is immutable: a finished first stop keeps what it had, the Termin goes to the next open stop of the place.
    while (lead < index && stops[lead].completedAt) lead += 1;
    if (scope === "STOP" && lead < index && hasTermin(stops[lead])) return { stopId, sharedStopIds: [], sharedPlace: null };
    const sharedStopIds = terminFollowerIds(stops, lead);
    const sequences = [stops[lead], ...stops.filter((item) => sharedStopIds.includes(item.id))].map((item) => item.sequence);
    return { stopId: stops[lead].id, sharedStopIds, sharedPlace: sharedStopIds.length ? { sequences, city: stops[lead].city } : null };
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

function parseSlot(input: AppointmentInput) {
  if (input.appointmentAt) {
    const appointmentAt = parseAppointment(input.appointmentAt);
    return { appointmentAt, windowStartAt: null, windowEndAt: null, deadline: appointmentAt };
  }
  if (input.windowStartAt && input.windowEndAt) {
    const windowStartAt = parseAppointment(input.windowStartAt);
    const windowEndAt = parseAppointment(input.windowEndAt);
    if (windowEndAt < windowStartAt) throw new TourPlanConflictError("Конец окна раньше начала.");
    return { appointmentAt: null, windowStartAt, windowEndAt, deadline: windowEndAt };
  }
  throw new TourPlanConflictError("Укажите время термина или окно.");
}

/** Null when nothing new is added, so the stored list is left as it is. */
function mergeReferences(json: string | null, added: string[]): string | null {
  let current: string[] = [];
  try { const value: unknown = JSON.parse(json ?? "[]"); if (Array.isArray(value)) current = value.filter((item): item is string => typeof item === "string"); } catch { /* legacy text */ }
  const fresh = added.map((item) => item.trim()).filter((item) => item && !current.includes(item));
  return fresh.length ? JSON.stringify([...current, ...fresh].slice(0, 40)) : null;
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
