import type { Prisma, PrismaClient, Stop, Tour } from "@prisma/client";
import {
  CALCULATED_POSITION_DISCLAIMER,
  buildSimpleDrivePlan,
  calculateClockAwareLegProgress,
  compareQueuedItems,
  readLegDrivePlan,
  readOptionalNumber,
  toNullableDate,
  type Coordinate,
  type RouteResult,
  type CurrentPosition,
  type StructuredCity
} from "../domain.js";
import type { RoutingProvider } from "./routing.js";
import { applyStopTime, createUnknownClockState, evaluateClockPlan, forecastDrive, type ClockState, type VehicleClockPlan } from "./vehicle-clock.js";
import {
  calculateDistanceTravelled,
  calculateEta,
  calculateLateMinutes,
  calculatePositionOnRoute,
  calculateRemainingDistance,
  calculateRiskColor,
  calculateSimulatedDuration,
  parseGeometry,
  serializeGeometry,
  splitGeometryAtProgress
} from "./simulation.js";

export type TourAggregate = Prisma.TourGetPayload<{
  include: {
    vehicle: true;
    stops: { orderBy: { sequence: "asc" } };
    legs: { orderBy: { createdAt: "asc" } };
    events: { orderBy: { timestamp: "asc" } };
    alerts: { orderBy: { createdAt: "desc" } };
  };
}> & { vehicle: { issues?: VehicleIssueTiming[] } };

export type CreateTourInput = {
  vehicleId: string;
  orderNumber: string;
  trailerPlate?: string | null;
  tourRemarks?: string | null;
  stops: Array<{
    sequence: number;
    type: "LOAD" | "UNLOAD";
    company?: string;
    address: string;
    city?: string | StructuredCity | null;
    appointmentAt?: string | null;
    appointmentWindowStartAt?: string | null;
    appointmentWindowEndAt?: string | null;
    loadingMeters?: number | null;
    referenceNumbers?: string[] | null;
    instructions?: string | null;
    serviceMinMinutes?: number | null;
    serviceMaxMinutes?: number | null;
    latitude?: number;
    longitude?: number;
  }>;
};

export type UpdateFutureTourInput = CreateTourInput;

export class TourPlanConflictError extends Error {
  readonly statusCode = 409;
}

export class TourService {
  constructor(
    private readonly db: PrismaClient,
    private readonly routingProvider: RoutingProvider
  ) {}

  async createTour(input: CreateTourInput): Promise<TourAggregate> {
    validateTourInput(input);
    const context = await readPlanningContext(this.db, input);
    const orderedStops = [...input.stops].sort((a, b) => a.sequence - b.sequence);
    const plan = await prepareTourPlan(this.routingProvider, orderedStops, context.previousTour?.stops[0], context.vehicle.maxSpeedKmh);

    return this.db.$transaction(async (tx) => {
      assertPlanningContextUnchanged(context, await readPlanningContext(tx, input));
      const { previousTourId, status } = context;
      const plannedStartAt = null;

      const tour = await tx.tour.create({
        data: {
          vehicleId: context.vehicle.id,
          orderNumber: input.orderNumber,
          trailerPlate: input.trailerPlate?.trim() || null,
          tourRemarks: input.tourRemarks?.trim() || null,
          planVersion: 0,
          queueIndex: context.queueIndex,
          status,
          previousTourId,
          plannedStartAt
        }
      });
      await persistTourPlan(tx, tour.id, plan);
      if (status === "ACTIVE" && input.trailerPlate?.trim()) {
        await updateCurrentTrailer(tx, context.vehicle.id, tour.id, input.trailerPlate.trim());
      }

      return tx.tour.findUniqueOrThrow({
        where: { id: tour.id },
        include: tourInclude
      });
    });
  }

  async createTourForNewVehicle(input: {
    vehicle: { vehicleNumber: string; licensePlate?: string | null };
    tour: Omit<CreateTourInput, "vehicleId">;
  }) {
    validateTourInput({ ...input.tour, vehicleId: "pending" });
    const orderedStops = [...input.tour.stops].sort((a, b) => a.sequence - b.sequence);
    const plan = await prepareTourPlan(this.routingProvider, orderedStops, undefined, 85);
    return this.db.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.create({ data: {
        vehicleNumber: input.vehicle.vehicleNumber.trim(),
        licensePlate: input.vehicle.licensePlate?.trim() || null,
        currentTrailerPlate: input.tour.trailerPlate?.trim() || null
      } });
      const tour = await tx.tour.create({ data: {
        vehicleId: vehicle.id,
        orderNumber: input.tour.orderNumber.trim(),
        trailerPlate: input.tour.trailerPlate?.trim() || null,
        tourRemarks: input.tour.tourRemarks?.trim() || null,
        status: "ACTIVE",
        queueIndex: 0,
        plannedStartAt: null
      } });
      await persistTourPlan(tx, tour.id, plan);
      if (input.tour.trailerPlate?.trim()) {
        await tx.operationEvent.create({ data: {
          vehicleId: vehicle.id, tourId: tour.id, type: "TRAILER_CHANGED",
          reason: "Прицеп назначен при создании первого тура.",
          payloadJson: JSON.stringify({ previous: null, current: input.tour.trailerPlate.trim() })
        } });
      }
      return { vehicle, tour: await tx.tour.findUniqueOrThrow({ where: { id: tour.id }, include: tourInclude }) };
    });
  }

  async updateFutureTour(tourId: string, input: UpdateFutureTourInput): Promise<TourAggregate> {
    validateTourInput(input);
    const context = await readPlanningContext(this.db, input, tourId);
    const orderedStops = [...input.stops].sort((a, b) => a.sequence - b.sequence);
    const plan = await prepareTourPlan(this.routingProvider, orderedStops, context.previousTour?.stops[0], context.vehicle.maxSpeedKmh);

    return this.db.$transaction(async (tx) => {
      assertPlanningContextUnchanged(context, await readPlanningContext(tx, input, tourId));
      const { status, previousTourId } = context;
      await tx.alert.deleteMany({ where: { tourId } });
      await tx.leg.deleteMany({ where: { tourId } });
      await tx.stop.deleteMany({ where: { tourId } });
      await tx.tour.update({
        where: { id: tourId },
        data: {
          vehicleId: input.vehicleId,
          orderNumber: input.orderNumber,
          trailerPlate: input.trailerPlate?.trim() || null,
          tourRemarks: input.tourRemarks?.trim() || null,
          planVersion: { increment: 1 },
          queueIndex: context.queueIndex,
          status,
          previousTourId,
          plannedStartAt: null
        }
      });
      await persistTourPlan(tx, tourId, plan);

      return tx.tour.findUniqueOrThrow({ where: { id: tourId }, include: tourInclude });
    });
  }

  async cancelFutureTour(tourId: string, now = new Date()): Promise<TourAggregate> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.tour.findUniqueOrThrow({
        where: { id: tourId },
        include: { stops: true, events: true, nextTours: true }
      });
      assertFutureTourEditable(current);

      if (current.nextTours.length > 0) {
        throw new TourPlanConflictError("Отменить можно только последний маршрут в очереди.");
      }

      await tx.alert.updateMany({ where: { tourId, resolvedAt: null }, data: { resolvedAt: now } });
      await tx.tour.update({
        where: { id: tourId },
        data: { status: "CANCELLED", completedAt: now }
      });
      return tx.tour.findUniqueOrThrow({ where: { id: tourId }, include: tourInclude });
    });
  }

  async recordLoaded(stopId: string, now = new Date(), note?: string): Promise<TourAggregate> {
    return this.recordStopEvent(stopId, "LOADED", now, note);
  }

  async recordUnloaded(stopId: string, now = new Date(), note?: string): Promise<TourAggregate> {
    return this.recordStopEvent(stopId, "UNLOADED", now, note);
  }

  async getCurrentPosition(vehicleId: string, now = new Date()): Promise<CurrentPosition> {
    await this.db.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    const activeTour = await this.db.tour.findFirst({
      where: { vehicleId, status: "ACTIVE" },
      include: { stops: { orderBy: { sequence: "asc" } } },
      orderBy: [{ queueIndex: "asc" }, { createdAt: "asc" }]
    });
    const vehicle = await this.db.vehicle.findUniqueOrThrow({ where: { id: vehicleId }, include: { issues: { where: { resolvedAt: null } } } });
    const activeLeg = await this.db.leg.findFirst({
      where: { tour: { vehicleId, status: "ACTIVE" }, status: { in: ["ACTIVE", "ARRIVED"] } },
      include: { toStop: true },
      orderBy: { startedAt: "desc" }
    });

    if (!activeLeg) {
      const stop = activeTour?.stops.find(item => item.arrivedAt && !item.completedAt);
      if (stop) return { ...emptyPosition("DWELL", activeTour?.id), state: "DWELL", status: "WAITING", position: toCoordinate(stop), coordinate: [stop.longitude, stop.latitude] };
      return emptyPosition(activeTour ? "WAITING_FOR_START" : "NO_ACTIVE_ROUTE", activeTour?.id);
    }

    const clock = snapshotVehicleClock(vehicle, activeLeg.toStop.arrivedAt ? null : activeLeg, now);
    const progress = activeLeg.toStop.arrivedAt ? 1 : activeLeg.simulatedDurationSeconds <= 0
      ? (activeLeg.startedAt ? 1 : 0)
      : Math.max(0, Math.min(1, clock.driveElapsedSeconds / activeLeg.simulatedDurationSeconds));
    const geometry = parseGeometry(activeLeg.routeGeometry);
    const position = calculatePositionOnRoute(geometry, progress);
    const breakdown = breakdownTiming(vehicle, now);
    const eta = breakdown.blocked ? breakdown.resumeAt
      ? new Date(forecastDrive(waitClockUntil(clock.clockState, breakdown.resumeAt), Math.max(0, activeLeg.simulatedDurationSeconds - clock.driveElapsedSeconds), breakdown.resumeAt).endAt)
      : null : clock.eta;
    const delayMinutes = activeLeg.toStop.appointmentAt ? calculateLateMinutes(eta, activeLeg.toStop.appointmentAt) : 0;
    const arrived = progress >= 1 && activeLeg.status !== "COMPLETED";
    const split = splitGeometryAtProgress(geometry, progress);
    let travelledPrefix: Coordinate[] = [];
    let previousTravelledDistanceMeters = 0;
    try {
      const details = JSON.parse(activeLeg.routeDetails ?? "{}") as { travelledGeometry?: Array<Coordinate | [number, number]>; previousTravelledDistanceMeters?: number };
      if (Array.isArray(details.travelledGeometry)) travelledPrefix = details.travelledGeometry.map(point => Array.isArray(point) ? { longitude: point[0], latitude: point[1] } : point);
      previousTravelledDistanceMeters = details.previousTravelledDistanceMeters ?? 0;
    } catch { /* Legacy routes need no prefix. */ }

    return {
      state: activeLeg.toStop.arrivedAt ? "DWELL" : arrived ? "ANGEKOMMEN_WARTET_AUF_BESTAETIGUNG" : "UNTERWEGS",
      status: breakdown.blocked || activeLeg.toStop.arrivedAt ? "WAITING" : arrived ? "ARRIVED" : clock.paused ? "WAITING" : "MOVING",
      disclaimer: CALCULATED_POSITION_DISCLAIMER,
      position,
      coordinate: position ? [position.longitude, position.latitude] : null,
      tourId: activeLeg.tourId,
      legId: activeLeg.id,
      geometryVersion: activeLeg.updatedAt.toISOString(),
      startedAt: activeLeg.startedAt?.toISOString() ?? null,
      delayMinutes,
      routeGeometry: [...travelledPrefix, ...geometry].map(toLonLat),
      travelledGeometry: [...travelledPrefix, ...split.travelledGeometry].map(toLonLat),
      remainingGeometry: split.remainingGeometry.map(toLonLat),
      progress,
      distanceTravelledMeters: previousTravelledDistanceMeters + calculateDistanceTravelled(activeLeg.distanceMeters, progress),
      remainingDistanceMeters: calculateRemainingDistance(activeLeg.distanceMeters, progress),
      eta: eta?.toISOString() ?? null
    };
  }

  private async recordStopEvent(
    stopId: string,
    eventType: "LOADED" | "UNLOADED",
    now: Date,
    note?: string
  ): Promise<TourAggregate> {
    const context = await readDepartureContext(this.db, stopId);
    assertStopActionAllowed(context.stop.completedAt, context.stop.tour.status, context.stop.arrivedAt);
    let refreshed: RouteResult | null = null;
    if (context.departureLeg) {
      const points = parseGeometry(context.departureLeg.routeGeometry);
      if (points.length >= 2) {
        try {
          refreshed = await this.routingProvider.calculateRoute(points[0], points[points.length - 1], {
            supportingPoints: points, source: "manual", departureTime: now,
            truck: { maxSpeedKmh: context.stop.tour.vehicle.maxSpeedKmh }
          });
        } catch { /* A service outage must not prevent recording the completed loading. */ }
      }
    }
    return this.db.$transaction(async (tx) => {
      if (JSON.stringify(context) !== JSON.stringify(await readDepartureContext(tx, stopId))) throw new TourPlanConflictError("Грузовик или маршрут изменились во время проверки трафика.");
      if (context.departureLeg) {
        const live = refreshed?.provider === "tomtom";
        await tx.leg.update({ where: { id: context.departureLeg.id }, data: {
          ...(live && refreshed ? { routeGeometry: serializeGeometry(refreshed.geometry), distanceMeters: refreshed.distanceMeters, routingDurationSeconds: refreshed.durationSeconds, simulatedDurationSeconds: calculateSimulatedDuration(refreshed.distanceMeters, refreshed.durationSeconds, context.stop.tour.vehicle.maxSpeedKmh) } : {}),
          routeDetails: JSON.stringify(live ? refreshed : { ...(refreshed ?? {}), providerStatus: "stale", warning: "Без актуальных данных о трафике и проверки ограничений для грузовиков" })
        } });
      }
      const stop = await tx.stop.findUniqueOrThrow({
        where: { id: stopId },
        include: { tour: { include: { vehicle: true, stops: { orderBy: { sequence: "asc" } }, legs: true } } }
      });

      if ((eventType === "LOADED" && stop.type !== "LOAD") || (eventType === "UNLOADED" && stop.type !== "UNLOAD")) {
        throw new TourPlanConflictError("Событие не соответствует типу точки.");
      }
      assertStopActionAllowed(stop.completedAt, stop.tour.status, stop.arrivedAt);
      if (stop.tour.stops.some((candidate) => candidate.sequence < stop.sequence && !candidate.completedAt)) {
        throw new TourPlanConflictError("Сначала необходимо завершить предыдущие точки.");
      }
      const clock = snapshotVehicleClock(stop.tour.vehicle, null, now).clockState;
      await tx.vehicle.update({ where: { id: stop.tour.vehicleId }, data: { clockState: JSON.stringify(clock), operationVersion: { increment: 1 } } });
      await tx.tour.update({ where: { id: stop.tourId }, data: { planVersion: { increment: 1 } } });

      if (eventType === "UNLOADED") {
        const previousLoad = stop.tour.stops
          .filter((candidate) => candidate.sequence < stop.sequence && candidate.type === "LOAD")
          .sort((a, b) => b.sequence - a.sequence)[0];
        if (previousLoad && !previousLoad.completedAt) {
          throw new TourPlanConflictError("Выгрузка до загрузки запрещена.");
        }
      }

      await tx.stop.update({ where: { id: stop.id }, data: { completedAt: now } });
      await tx.event.create({
        data: {
          vehicleId: stop.tour.vehicleId,
          tourId: stop.tourId,
          stopId: stop.id,
          type: eventType,
          timestamp: now,
          note
        }
      });

      if (eventType === "LOADED" && !stop.tour.actualStartAt) {
        await tx.tour.update({ where: { id: stop.tourId }, data: { actualStartAt: now } });
      }

      const incomingLeg = stop.tour.legs.find((leg) => leg.toStopId === stop.id);
      if (incomingLeg) {
        await tx.leg.update({
          where: { id: incomingLeg.id },
          data: { status: "COMPLETED", finishedAt: now }
        });
      }

      const outgoingLeg = stop.tour.legs.find((leg) => leg.fromStopId === stop.id);
      if (outgoingLeg) {
        await tx.leg.update({
          where: { id: outgoingLeg.id },
          data: { status: "ACTIVE", startedAt: now, drivePlan: JSON.stringify(makePersistedDrivePlan(clock, outgoingLeg.simulatedDurationSeconds, now)) }
        });
      } else {
        await tx.tour.update({ where: { id: stop.tourId }, data: { status: "COMPLETED", completedAt: now } });
        await activateNextQueuedTour(tx, stop.tour.vehicleId, now);
      }

      return tx.tour.findUniqueOrThrow({ where: { id: stop.tourId }, include: tourInclude });
    });
  }
}

async function readDepartureContext(db: Prisma.TransactionClient, stopId: string) {
  const stop = await db.stop.findUniqueOrThrow({ where: { id: stopId }, include: {
    tour: { include: { vehicle: true, stops: { orderBy: { sequence: "asc" } }, legs: true } }
  } });
  let departureLeg = stop.tour.legs.find(leg => leg.fromStopId === stopId) ?? null;
  if (!departureLeg) {
    const nextTour = await db.tour.findFirst({ where: { vehicleId: stop.tour.vehicleId, status: "QUEUED" }, orderBy: [{ queueIndex: "asc" }, { createdAt: "asc" }], include: { legs: true } });
    departureLeg = nextTour?.legs.find(leg => leg.fromStopId === stopId) ?? null;
  }
  return { stop, departureLeg };
}

async function readPlanningContext(db: Prisma.TransactionClient, input: CreateTourInput, tourId?: string) {
  const current = tourId
    ? await db.tour.findUnique({
        where: { id: tourId },
        include: {
          stops: { orderBy: { sequence: "asc" } },
          events: { orderBy: [{ timestamp: "asc" }, { id: "asc" }] },
          nextTours: { orderBy: { id: "asc" } }
        }
      })
    : null;
  if (tourId && !current) throw new TourPlanConflictError("Маршрут больше не существует. Обновите страницу.");
  if (current) {
    assertFutureTourEditable(current);
    if (current.nextTours.length > 0) {
      throw new TourPlanConflictError(
        "Изменять можно только последний маршрут в очереди, чтобы сохранить следующие транзитные участки."
      );
    }
  }

  const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: input.vehicleId } });
  const openTours = await db.tour.findMany({
    where: {
      vehicleId: input.vehicleId,
      ...(tourId ? { id: { not: tourId } } : {}),
      status: { in: ["ACTIVE", "QUEUED"] }
    },
    orderBy: [{ queueIndex: "asc" }, { plannedStartAt: "asc" }, { createdAt: "asc" }, { id: "asc" }]
  });
  const placement = current?.vehicleId === input.vehicleId
    ? { status: current.status, previousTourId: current.previousTourId, queueIndex: current.queueIndex }
    : determineNewTourPlacement(openTours);
  const previousTour = placement.previousTourId
    ? await db.tour.findUnique({
        where: { id: placement.previousTourId },
        include: { stops: { orderBy: { sequence: "desc" }, take: 1 } }
      })
    : null;

  return { vehicle, openTours, current, previousTour, ...placement };
}

function assertPlanningContextUnchanged(
  expected: Awaited<ReturnType<typeof readPlanningContext>>,
  actual: Awaited<ReturnType<typeof readPlanningContext>>
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new TourPlanConflictError("План маршрута изменился во время расчёта. Сохраните повторно.");
  }
}

async function prepareTourPlan(
  routingProvider: RoutingProvider,
  orderedStops: CreateTourInput["stops"],
  previousFinalStop: Stop | undefined,
  maxSpeedKmh: number
) {
  const stops: Array<CreateTourInput["stops"][number] & Coordinate> = [];
  for (const stopInput of orderedStops) {
    const coordinate = await resolveStopCoordinate(routingProvider, stopInput);
    stops.push({ ...stopInput, ...coordinate });
  }

  const legs: Array<{
    fromIndex: number;
    toIndex: number;
    previousStopId?: string;
    distanceMeters: number;
    routeGeometry: string;
    routingDurationSeconds: number;
    simulatedDurationSeconds: number;
    drivePlan: string;
    routeDetails: string;
  }> = [];
  for (let toIndex = previousFinalStop ? 0 : 1; toIndex < stops.length; toIndex += 1) {
    const fromStop = toIndex === 0 ? previousFinalStop! : stops[toIndex - 1];
    const route = await routingProvider.calculateRoute(toCoordinate(fromStop), toCoordinate(stops[toIndex]));
    const simulatedDurationSeconds = calculateSimulatedDuration(route.distanceMeters, route.durationSeconds, maxSpeedKmh);
    legs.push({
      fromIndex: toIndex - 1,
      toIndex,
      ...(toIndex === 0 ? { previousStopId: previousFinalStop!.id } : {}),
      distanceMeters: route.distanceMeters,
      routeGeometry: serializeGeometry(route.geometry),
      routingDurationSeconds: route.durationSeconds,
      simulatedDurationSeconds,
      drivePlan: JSON.stringify(buildSimpleDrivePlan(simulatedDurationSeconds)),
      routeDetails: JSON.stringify(route)
    });
  }
  return { stops, legs };
}

async function persistTourPlan(
  tx: Prisma.TransactionClient,
  tourId: string,
  plan: Awaited<ReturnType<typeof prepareTourPlan>>
): Promise<void> {
  const stopIds: string[] = [];
  for (const stop of plan.stops) {
    const created = await tx.stop.create({
      data: {
        tourId,
        sequence: stop.sequence,
        type: stop.type,
        company: stop.company,
        address: stop.address,
        latitude: stop.latitude,
        longitude: stop.longitude,
        city: normalizeCity(stop.city),
        appointmentAt: toNullableDate(stop.appointmentAt),
        appointmentWindowStartAt: toNullableDate(stop.appointmentWindowStartAt),
        appointmentWindowEndAt: toNullableDate(stop.appointmentWindowEndAt),
        loadingMeters: stop.loadingMeters ?? null,
        referenceNumbersJson: stop.referenceNumbers?.length ? JSON.stringify(stop.referenceNumbers) : null,
        instructions: stop.instructions?.trim() || null,
        serviceMinMinutes: normalizeServiceMinutes(stop.serviceMinMinutes, 60),
        serviceMaxMinutes: normalizeServiceMinutes(stop.serviceMaxMinutes, 120)
      }
    });
    stopIds.push(created.id);
  }
  for (const { fromIndex, toIndex, previousStopId, ...leg } of plan.legs) {
    await tx.leg.create({
      data: { ...leg, tourId, fromStopId: previousStopId ?? stopIds[fromIndex], toStopId: stopIds[toIndex] }
    });
  }
}

function assertFutureTourEditable(tour: {
  status: string;
  events: unknown[];
  stops: Array<{ completedAt: Date | null }>;
}): void {
  const hasRecordedHistory = tour.events.length > 0 || tour.stops.some((stop) => stop.completedAt);
  if (tour.status !== "QUEUED" || hasRecordedHistory) {
    throw new TourPlanConflictError(
      "Изменять или отменять можно только будущие маршруты в очереди без подтверждённых событий."
    );
  }
}

export function determineNewTourPlacement(
  openTours: Array<Pick<Tour, "id" | "status" | "plannedStartAt" | "createdAt"> & Partial<Pick<Tour, "queueIndex">>>
): { status: "ACTIVE" | "QUEUED"; previousTourId?: string; queueIndex: number } {
  if (openTours.length === 0) return { status: "ACTIVE", queueIndex: 0 };
  const previousTour = [...openTours].sort(compareQueuedItems).at(-1);
  const previousQueueIndex = readOptionalNumber(previousTour, "queueIndex");
  const maxQueueIndex = Math.max(-1, ...openTours.map((tour) => readOptionalNumber(tour, "queueIndex") ?? -1));
  return {
    status: "QUEUED",
    previousTourId: previousTour?.id,
    queueIndex: previousQueueIndex !== null ? previousQueueIndex + 1 : maxQueueIndex + 1
  };
}

export const tourInclude = {
  vehicle: { include: { issues: { where: { resolvedAt: null } } } },
  stops: { orderBy: { sequence: "asc" } },
  legs: { orderBy: { createdAt: "asc" } },
  events: { orderBy: { timestamp: "asc" } },
  alerts: { orderBy: { createdAt: "desc" } }
} satisfies Prisma.TourInclude;

export function enrichTour(tour: TourAggregate, now = new Date()) {
  const activeLeg = tour.legs.find((leg) => leg.status === "ACTIVE" || leg.status === "ARRIVED");
  const nextStop = activeLeg
    ? tour.stops.find((stop) => stop.id === activeLeg.toStopId)
    : tour.stops.find((stop) => !stop.completedAt);
  const eta = activeLeg ? positionEta(tour.vehicle, activeLeg, now) : null;

  const currentDelayMinutes = nextStop ? calculateLateMinutes(eta, nextStop.appointmentAt) : 0;
  return {
    ...toIsoObject(tour),
    stops: tour.stops.map(toIsoObject),
    legs: tour.legs.map((leg) => {
      const snapshot = snapshotVehicleClock(tour.vehicle, leg, now);
      const progress = leg.status === "COMPLETED" ? 1 : snapshot.progress;
      return {
        ...toIsoObject(leg),
        progress,
        eta: positionEta(tour.vehicle, leg, now)?.toISOString() ?? null
      };
    }),
    events: tour.events.map(toIsoObject),
    alerts: tour.alerts.map(toIsoObject),
    currentEta: eta?.toISOString() ?? null,
    currentDelayMinutes,
    predictedEta: eta?.toISOString() ?? null,
    predictedDelayMinutes: currentDelayMinutes,
    riskColor: calculateRiskColor(eta, nextStop?.appointmentAt)
  };
}

/** Lightweight active-tour contract for the frequently refreshed dashboard. */
export function toDashboardTourSummary(tour: TourAggregate) {
  const { vehicle: _vehicle, legs: _legs, events: _events, alerts: _alerts, stops, ...summary } = tour;
  return {
    ...toIsoObject(summary),
    stops: stops.map(toIsoObject)
  };
}

export function toIsoObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, item instanceof Date ? item.toISOString() : item])
  ) as T;
}

async function activateNextQueuedTour(tx: Prisma.TransactionClient, vehicleId: string, startedAt: Date): Promise<Tour | null> {
  const queuedTours = await tx.tour.findMany({
    where: { vehicleId, status: "QUEUED" },
    orderBy: [{ queueIndex: "asc" }, { plannedStartAt: "asc" }, { createdAt: "asc" }]
  });
  const nextTour = selectNextQueuedTour(queuedTours);
  if (!nextTour) return null;
  const activatedTour = await tx.tour.update({ where: { id: nextTour.id }, data: { status: "ACTIVE" } });
  if (activatedTour.trailerPlate) await updateCurrentTrailer(tx, vehicleId, activatedTour.id, activatedTour.trailerPlate);
  const firstStop = await tx.stop.findFirst({
    where: { tourId: nextTour.id },
    orderBy: { sequence: "asc" }
  });
  if (firstStop) {
    const transferLeg = await tx.leg.findFirst({
      where: { tourId: nextTour.id, toStopId: firstStop.id, status: "WAITING" }
    });
    if (transferLeg) {
      await tx.leg.update({
        where: { id: transferLeg.id },
        data: { status: "ACTIVE", startedAt, drivePlan: JSON.stringify(makePersistedDrivePlan(parseClockState((await tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).clockState, startedAt), transferLeg.simulatedDurationSeconds, startedAt)) }
      });
    }
  }
  return activatedTour;
}

async function updateCurrentTrailer(tx: Prisma.TransactionClient, vehicleId: string, tourId: string, trailerPlate: string): Promise<void> {
  const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
  if (vehicle.currentTrailerPlate === trailerPlate) return;
  await tx.vehicle.update({ where: { id: vehicleId }, data: { currentTrailerPlate: trailerPlate } });
  await tx.operationEvent.create({ data: {
    vehicleId, tourId, type: "TRAILER_CHANGED",
    reason: "Смена прицепа при начале тура.",
    payloadJson: JSON.stringify({ previous: vehicle.currentTrailerPlate, current: trailerPlate })
  } });
}

export function selectNextQueuedTour<T extends Pick<Tour, "id" | "status" | "plannedStartAt" | "createdAt"> & Partial<Pick<Tour, "queueIndex">>>(
  tours: T[]
): T | null {
  return (
    [...tours]
      .filter((tour) => tour.status === "QUEUED")
      .sort(compareQueuedItems)[0] ?? null
  );
}

export function assertStopActionAllowed(completedAt: Date | null, tourStatus: string, arrivedAt?: Date | null): void {
  if (completedAt) {
    throw new TourPlanConflictError("Точка уже подтверждена.");
  }
  if (tourStatus !== "ACTIVE") {
    throw new TourPlanConflictError("Действия разрешены только для активных маршрутов.");
  }
  if (!arrivedAt) {
    throw new TourPlanConflictError("Перед завершением точки необходимо подтвердить прибытие.");
  }
}

async function resolveStopCoordinate(
  routingProvider: RoutingProvider,
  stop: CreateTourInput["stops"][number]
): Promise<Coordinate> {
  if (typeof stop.latitude === "number" && typeof stop.longitude === "number") {
    return { latitude: stop.latitude, longitude: stop.longitude };
  }

  return routingProvider.geocode(stop.address);
}

function validateTourInput(input: CreateTourInput): void {
  if (!input.vehicleId) throw new Error("Необходимо выбрать грузовик.");
  if (!input.orderNumber.trim()) throw new Error("Необходимо указать номер заказа.");
  if (input.stops.length < 2) throw new Error("Маршрут должен содержать минимум две точки.");

  const sequences = new Set<number>();
  for (const stop of input.stops) {
    if (!stop.address.trim()) throw new Error("Точка без адреса не допускается.");
    if (!Number.isInteger(stop.sequence)) throw new Error("Для каждой точки необходимо указать порядковый номер.");
    if (sequences.has(stop.sequence)) throw new Error("Порядковый номер точки должен быть уникальным.");
    if (stop.appointmentAt !== null && stop.appointmentAt !== undefined && !toNullableDate(stop.appointmentAt)) {
      throw new Error("Срок указан некорректно.");
    }
    const minimum = stop.serviceMinMinutes ?? 60;
    const maximum = stop.serviceMaxMinutes ?? 120;
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum) {
      throw new Error("Некорректный диапазон времени стоянки.");
    }
    sequences.add(stop.sequence);
  }
}

export type VehicleClockSnapshot = {
  clockState: ClockState;
  driveElapsedSeconds: number;
  wallElapsedSeconds: number;
  progress: number;
  arrived: boolean;
  paused: boolean;
  pauseKind?: string;
  eta: Date | null;
};

export type VehicleIssueTiming = { kind: string; resolvedAt: Date | null; expectedResolvedAt: Date | null };

export function breakdownTiming(vehicle: { issues?: VehicleIssueTiming[] }, now: Date): { blocked: boolean; resumeAt: Date | null } {
  const issues = vehicle.issues?.filter(issue => issue.kind === "BREAKDOWN" && !issue.resolvedAt) ?? [];
  if (!issues.length) return { blocked: false, resumeAt: null };
  // An overdue repair estimate is no longer a trustworthy departure time.
  if (issues.some(issue => !issue.expectedResolvedAt || issue.expectedResolvedAt <= now)) return { blocked: true, resumeAt: null };
  return { blocked: true, resumeAt: new Date(Math.max(...issues.map(issue => issue.expectedResolvedAt!.getTime()))) };
}

export function waitClockUntil(clock: ClockState, at: Date): ClockState {
  return applyStopTime(clock, Math.max(0, (at.getTime() - new Date(clock.updatedAt).getTime()) / 1000), clock.updatedAt).state;
}

function positionEta(vehicle: { clockState?: string | null; manualStoppedAt?: Date | null; issues?: VehicleIssueTiming[] }, leg: Parameters<typeof snapshotVehicleClock>[1], now: Date): Date | null {
  const snapshot = snapshotVehicleClock(vehicle, leg, now);
  const breakdown = breakdownTiming(vehicle, now);
  if (!breakdown.blocked) return snapshot.eta;
  if (!leg || !breakdown.resumeAt) return null;
  return new Date(forecastDrive(waitClockUntil(snapshot.clockState, breakdown.resumeAt), Math.max(0, leg.simulatedDurationSeconds - snapshot.driveElapsedSeconds), breakdown.resumeAt).endAt);
}

export type PersistedDrivePlan = { clockPlan: VehicleClockPlan; drivenOffsetSeconds: number; totalDriveSeconds: number };

export function parseClockState(raw: string | null | undefined, now: Date): ClockState {
  try {
    const parsed = raw ? JSON.parse(raw) as ClockState : null;
    if (parsed && ["KNOWN", "UNKNOWN"].includes(parsed.kind) && parsed.currentCycle && parsed.weeklyExtendedDrive && Array.isArray(parsed.warnings)) return parsed;
  } catch { /* Legacy or corrupt state must not become a rested machine. */ }
  return createUnknownClockState(now);
}

export function readPersistedDrivePlan(raw: string | null | undefined): PersistedDrivePlan | null {
  try {
    const parsed = raw ? JSON.parse(raw) as PersistedDrivePlan : null;
    if (parsed?.clockPlan?.steps && Number.isFinite(parsed.drivenOffsetSeconds)) return parsed;
  } catch { /* Older leg plans remain preliminary. */ }
  return null;
}

export function makePersistedDrivePlan(clock: ClockState, seconds: number, now: Date, drivenOffsetSeconds = 0): PersistedDrivePlan {
  return { clockPlan: forecastDrive(clock, seconds, now).plan, drivenOffsetSeconds, totalDriveSeconds: seconds + drivenOffsetSeconds };
}

export function snapshotVehicleClock(
  vehicle: { clockState?: string | null; manualStoppedAt?: Date | null; operationVersion?: number | null },
  activeLeg: {
    startedAt: Date | null;
    simulatedDurationSeconds: number;
    drivePlan?: string | null;
    finishedAt?: Date | null;
  } | null,
  now: Date
): VehicleClockSnapshot {
  const existingClock = parseClockState(vehicle.clockState, now);
  if (!activeLeg || !activeLeg.startedAt) {
    return {
      clockState: applyStopTime(existingClock, Math.max(0, (now.getTime() - new Date(existingClock.updatedAt).getTime()) / 1000), existingClock.updatedAt).state,
      driveElapsedSeconds: 0,
      wallElapsedSeconds: 0,
      progress: 0,
      arrived: false,
      paused: Boolean(vehicle.manualStoppedAt),
      pauseKind: vehicle.manualStoppedAt ? "MANUAL_STOP" : undefined,
      eta: null
    };
  }
  const stored = readPersistedDrivePlan(activeLeg.drivePlan);
  if (stored) {
    const at = vehicle.manualStoppedAt && vehicle.manualStoppedAt < now ? vehicle.manualStoppedAt : now;
    const evaluated = evaluateClockPlan(stored.clockPlan, at);
    const driveElapsedSeconds = stored.drivenOffsetSeconds + stored.clockPlan.steps.reduce((sum, step) => step.segment.type === "DRIVE"
      ? sum + Math.max(0, Math.min(step.segment.durationSeconds, (at.getTime() - new Date(step.segment.startAt).getTime()) / 1000)) : sum, 0);
    const progress = stored.totalDriveSeconds > 0 ? Math.min(1, driveElapsedSeconds / stored.totalDriveSeconds) : 1;
    const kind = evaluated.activeSegment?.type ?? evaluated.remainingSegments[0]?.type;
    const paused = Boolean(vehicle.manualStoppedAt) || (kind !== undefined && kind !== "DRIVE");
    let clockState = evaluated.isComplete && at > new Date(stored.clockPlan.endAt)
      ? applyStopTime(evaluated.state, (at.getTime() - new Date(stored.clockPlan.endAt).getTime()) / 1000, stored.clockPlan.endAt).state : evaluated.state;
    if (vehicle.manualStoppedAt && now > vehicle.manualStoppedAt) {
      clockState = applyStopTime(existingClock, Math.max(0, (now.getTime() - new Date(existingClock.updatedAt).getTime()) / 1000), existingClock.updatedAt).state;
    }
    return { clockState, driveElapsedSeconds, wallElapsedSeconds: Math.max(0, (at.getTime() - activeLeg.startedAt.getTime()) / 1000), progress, arrived: progress >= 1, paused, pauseKind: vehicle.manualStoppedAt ? "MANUAL_STOP" : paused ? kind : undefined, eta: new Date(stored.clockPlan.endAt) };
  }
  const clockProgress = calculateClockAwareLegProgress({
    startedAt: activeLeg.startedAt,
    now,
    manualStoppedAt: vehicle.manualStoppedAt,
    drivePlan: readLegDrivePlan(activeLeg) ?? buildSimpleDrivePlan(activeLeg.simulatedDurationSeconds)
  });
  const progress = activeLeg.simulatedDurationSeconds <= 0
    ? 1
    : Math.max(0, Math.min(1, clockProgress.driveElapsedSeconds / activeLeg.simulatedDurationSeconds));
  const arrived = Boolean(activeLeg.finishedAt) || progress >= 1;

  return {
    clockState: createUnknownClockState(now),
    driveElapsedSeconds: clockProgress.driveElapsedSeconds,
    wallElapsedSeconds: clockProgress.wallElapsedSeconds,
    progress,
    arrived,
    paused: clockProgress.paused,
    pauseKind: clockProgress.pauseKind,
    eta: calculateEta(activeLeg.startedAt, readLegDrivePlan(activeLeg)?.totalElapsedSeconds ?? activeLeg.simulatedDurationSeconds)
  };
}

export async function rebaseActiveLeg(
  tx: Prisma.TransactionClient,
  vehicleId: string,
  clock: ClockState | null,
  now: Date
): Promise<VehicleClockSnapshot | null> {
  const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
  const activeLeg = await tx.leg.findFirst({
    where: { tour: { vehicleId, status: "ACTIVE" }, status: { in: ["ACTIVE", "ARRIVED"] } },
    orderBy: { startedAt: "desc" }
  });
  const snapshot = snapshotVehicleClock(
    vehicle,
    activeLeg,
    now
  );
  const effectiveClock = clock ?? snapshot.clockState;
  if (activeLeg && activeLeg.status === "ACTIVE") {
    await tx.leg.update({ where: { id: activeLeg.id }, data: { drivePlan: JSON.stringify(makePersistedDrivePlan(effectiveClock, Math.max(0, activeLeg.simulatedDurationSeconds - snapshot.driveElapsedSeconds), now, snapshot.driveElapsedSeconds)) } });
  }
  await tx.vehicle.update({
    where: { id: vehicleId },
    data: {
      clockState: JSON.stringify(effectiveClock)
    }
  });
  return snapshot;
}

function normalizeCity(city: string | StructuredCity | null | undefined): string | null {
  if (!city) return null;
  return typeof city === "string" ? city : city.name;
}

function normalizeServiceMinutes(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

function toCoordinate(stop: Pick<Stop, "latitude" | "longitude">): Coordinate {
  return { latitude: stop.latitude, longitude: stop.longitude };
}

function emptyPosition(state: CurrentPosition["state"], tourId?: string): CurrentPosition {
  const status = state === "WAITING_FOR_START" ? "WAITING" : state === "COMPLETED" ? "IDLE" : "IDLE";
  return {
    state,
    status,
    disclaimer: CALCULATED_POSITION_DISCLAIMER,
    position: null,
    coordinate: null,
    tourId: tourId ?? null,
    legId: null,
    geometryVersion: null,
    startedAt: null,
    delayMinutes: 0,
    routeGeometry: [],
    travelledGeometry: [],
    remainingGeometry: [],
    progress: 0,
    distanceTravelledMeters: 0,
    remainingDistanceMeters: 0,
    eta: null
  };
}

function toLonLat(coordinate: Coordinate): [number, number] {
  return [coordinate.longitude, coordinate.latitude];
}
