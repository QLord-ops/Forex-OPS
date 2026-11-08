import { createHash } from "node:crypto";
import type { RoadSection, TrafficSection } from "./traffic-routing.js";
import type { Prisma, PrismaClient, Stop, Tour, Vehicle } from "@prisma/client";
import {
  CALCULATED_POSITION_DISCLAIMER,
  LAST_STOP_POSITION_DISCLAIMER,
  MANUAL_POSITION_DISCLAIMER,
  buildSimpleDrivePlan,
  calculateClockAwareLegProgress,
  compareQueuedItems,
  readLegDrivePlan,
  readOptionalNumber,
  toNullableDate,
  type Coordinate,
  type RouteResult,
  type CurrentPosition,
  type GpsFix,
  type StructuredCity
} from "../domain.js";
import type { RoutingProvider } from "./routing.js";
import { OFF_ROUTE_METERS, projectOnLine, splitAtProjection } from "./route-projection.js";
import { cleanTravelled } from "./travelled-path.js";
import { requiresTermin } from "./address-rules.js";
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
import { writeAuditLog, type AuditActor } from "./audit-log.js";
import type { AutoStopEventInput } from "./webfleet.js";

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
  /** The customer the Auftrag was read for (set by the server from the stored document, never by the client). */
  customerId?: string | null;
  trailerPlate?: string | null;
  tourRemarks?: string | null;
  stops: Array<{
    /** Existing stop being edited: fields left out of the input keep their saved values. */
    id?: string;
    sequence: number;
    type: "LOAD" | "UNLOAD";
    company?: string;
    address: string;
    sourceAddress?: string | null;
    resolvedAddress?: string | null;
    geocodePrecision?: "EXACT" | "STREET" | "POSTCODE_CITY" | "CITY" | null;
    geocodeProvider?: string | null;
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
    plannedAt?: string | null;
    departureDeadlineAt?: string | null;
    learnLabel?: string | null;
  }>;
};

/** `version` is the tour's planVersion the dispatcher edited; a newer plan rejects the edit. */
export type UpdateFutureTourInput = CreateTourInput & { version?: number };

export type ImportTourMetadata = {
  importAttemptId: string;
  importFingerprint: string;
};

export class TourPlanConflictError extends Error {
  readonly statusCode = 409;
}

export class TourService {
  constructor(
    private readonly db: PrismaClient,
    private readonly routingProvider: RoutingProvider
  ) {}

  async createTour(input: CreateTourInput, actor?: AuditActor): Promise<TourAggregate> {
    return this.createTourInternal(input, undefined, actor);
  }

  async createImportedTour(
    input: CreateTourInput,
    metadata: ImportTourMetadata,
    actor?: AuditActor,
  ): Promise<{ tour: TourAggregate; created: boolean }> {
    if (!metadata.importAttemptId.trim() || !metadata.importFingerprint.trim()) {
      throw Object.assign(new Error("Для импорта отсутствует идентификатор повторной попытки."), { statusCode: 400 });
    }

    const existing = await this.findImportedTour(metadata);
    if (existing) return { tour: assertImportedTourVehicle(existing, input.vehicleId), created: false };

    try {
      return { tour: await this.createTourInternal(input, metadata, actor), created: true };
    } catch (error) {
      // A concurrent retry may win the unique key race after route calculation.
      const concurrent = await this.findImportedTour(metadata);
      if (concurrent) return { tour: assertImportedTourVehicle(concurrent, input.vehicleId), created: false };
      throw error;
    }
  }

  private async findImportedTour(metadata: ImportTourMetadata): Promise<TourAggregate | null> {
    return this.db.tour.findFirst({
      where: {
        OR: [
          { importAttemptId: metadata.importAttemptId },
          { importFingerprint: metadata.importFingerprint }
        ]
      },
      include: tourInclude
    });
  }

  private async createTourInternal(input: CreateTourInput, metadata?: ImportTourMetadata, actor?: AuditActor): Promise<TourAggregate> {
    validateTourInput(input);
    const context = await readPlanningContext(this.db, input);
    const orderedStops = [...input.stops].sort((a, b) => a.sequence - b.sequence);
    const plan = await prepareTourPlan(this.routingProvider, orderedStops, context.previousTour?.stops[0], context.vehicle.maxSpeedKmh);
    // A tour with an earlier load date goes before later ones; the tour after it gets a new transfer leg.
    const next = context.insertBefore;
    const nextTransfer = next?.firstStop
      ? await prepareTransferLeg(this.routingProvider, plan.stops.at(-1)!, next.firstStop, context.vehicle.maxSpeedKmh)
      : null;

    return this.db.$transaction(async (tx) => {
      assertPlanningContextUnchanged(context, await readPlanningContext(tx, input));
      const { previousTourId, status } = context;
      const plannedStartAt = tourStartFromStops(orderedStops);
      if (next) {
        const later = context.openTours.filter((tour) => (tour.queueIndex ?? 0) >= next.queueIndex);
        for (const tour of later) await tx.tour.update({ where: { id: tour.id }, data: { queueIndex: { increment: 1 } } });
      }

      const customer = await tourCustomer(tx, context.vehicle.customerLineId, input.customerId);
      const tour = await tx.tour.create({
        data: {
          vehicleId: context.vehicle.id,
          orderNumber: input.orderNumber,
          customerId: customer.customerId,
          customerLineId: customer.customerLineId,
          importAttemptId: metadata?.importAttemptId,
          importFingerprint: metadata?.importFingerprint,
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
      if (next && nextTransfer) await relinkFollowingTour(tx, tour.id, next, nextTransfer);
      if (status === "ACTIVE" && input.trailerPlate?.trim()) {
        await updateCurrentTrailer(tx, context.vehicle.id, tour.id, input.trailerPlate.trim());
      }
      await writeAuditLog(tx, actor, { action: metadata ? "TOUR_IMPORTED" : "TOUR_CREATED", entityType: "Tour", entityId: tour.id,
        vehicleId: context.vehicle.id, tourId: tour.id, metadata: { orderNumber: input.orderNumber, ...(next ? { insertedBefore: next.id } : {}) } });

      return tx.tour.findUniqueOrThrow({
        where: { id: tour.id },
        include: tourInclude
      });
    });
  }

  async createTourForNewVehicle(input: {
    vehicle: { vehicleNumber: string; licensePlate?: string | null };
    tour: Omit<CreateTourInput, "vehicleId">;
  }, actor?: AuditActor) {
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
        customerId: input.tour.customerId ?? null,
        trailerPlate: input.tour.trailerPlate?.trim() || null,
        tourRemarks: input.tour.tourRemarks?.trim() || null,
        status: "ACTIVE",
        queueIndex: 0,
        plannedStartAt: tourStartFromStops(orderedStops)
      } });
      await persistTourPlan(tx, tour.id, plan);
      if (input.tour.trailerPlate?.trim()) {
        await tx.operationEvent.create({ data: {
          vehicleId: vehicle.id, tourId: tour.id, type: "TRAILER_CHANGED",
          reason: "Прицеп назначен при создании первого тура.",
          payloadJson: JSON.stringify({ previous: null, current: input.tour.trailerPlate.trim() })
        } });
      }
      await writeAuditLog(tx, actor, { action: "TOUR_CREATED", entityType: "Tour", entityId: tour.id,
        vehicleId: vehicle.id, tourId: tour.id, metadata: { orderNumber: input.tour.orderNumber, vehicleCreated: true } });
      return { vehicle, tour: await tx.tour.findUniqueOrThrow({ where: { id: tour.id }, include: tourInclude }) };
    });
  }

  async updateFutureTour(tourId: string, rawInput: UpdateFutureTourInput, actor?: AuditActor): Promise<TourAggregate> {
    const saved = await this.db.tour.findUnique({ where: { id: tourId }, include: { stops: true } });
    if (saved && rawInput.version !== undefined && saved.planVersion !== rawInput.version) {
      throw new TourPlanConflictError("Маршрут уже изменили. Обновите страницу и внесите правку заново.");
    }
    const input = saved ? keepSavedTourFields(rawInput, saved) : rawInput;
    validateTourInput(input);
    const context = await readPlanningContext(this.db, input, tourId);
    const orderedStops = [...input.stops].sort((a, b) => a.sequence - b.sequence);
    const plan = await prepareTourPlan(this.routingProvider, orderedStops, context.previousTour?.stops[0], context.vehicle.maxSpeedKmh);

    return this.db.$transaction(async (tx) => {
      assertPlanningContextUnchanged(context, await readPlanningContext(tx, input, tourId));
      if (saved) {
        const fresh = await tx.tour.findUnique({ where: { id: tourId } });
        if (fresh?.planVersion !== saved.planVersion) throw new TourPlanConflictError("Маршрут уже изменили. Обновите страницу и внесите правку заново.");
      }
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
          plannedStartAt: tourStartFromStops(orderedStops)
        }
      });
      await persistTourPlan(tx, tourId, plan);
      await writeAuditLog(tx, actor, { action: "TOUR_UPDATED", entityType: "Tour", entityId: tourId,
        vehicleId: input.vehicleId, tourId, metadata: { orderNumber: input.orderNumber } });

      return tx.tour.findUniqueOrThrow({ where: { id: tourId }, include: tourInclude });
    });
  }

  /**
   * Cancels a tour that has not begun: any tour in the queue, or the current one before the first arrival.
   * Nothing is erased: the tour keeps its stops and gets the CANCELLED status; the queue closes the gap.
   */
  async cancelTour(tourId: string, version?: number, now = new Date(), actor?: AuditActor): Promise<TourAggregate> {
    const read = (db: Prisma.TransactionClient) => db.tour.findUniqueOrThrow({
      where: { id: tourId },
      include: { vehicle: true, stops: { orderBy: { sequence: "asc" } }, legs: true, events: { take: 1 }, nextTours: { where: { status: "QUEUED" }, include: { stops: { orderBy: { sequence: "asc" }, take: 1 } } } }
    });
    const current = await read(this.db);
    assertTourCancellable(current, version);
    const next = current.nextTours[0] ?? null;
    // The following tour now drives from the stop before the gap; at the front of the queue it starts without a transfer.
    const predecessor = current.status === "QUEUED" && current.previousTourId
      ? await this.db.tour.findUnique({ where: { id: current.previousTourId }, include: { stops: { orderBy: { sequence: "desc" }, take: 1 } } })
      : null;
    const fromStop = predecessor?.stops[0] ?? null;
    const transfer = next?.stops[0] && fromStop
      ? await prepareTransferLeg(this.routingProvider, fromStop, next.stops[0], current.vehicle.maxSpeedKmh)
      : null;

    return this.db.$transaction(async (tx) => {
      const fresh = await read(tx);
      assertTourCancellable(fresh, version);
      if (fresh.planVersion !== current.planVersion || fresh.nextTours[0]?.id !== next?.id) throw new TourPlanConflictError("Тур изменился. Обновите страницу.");
      const stopIds = fresh.stops.map((stop) => stop.id);
      if (next) {
        const ownStopIds = (await tx.stop.findMany({ where: { tourId: next.id }, select: { id: true } })).map((stop) => stop.id);
        await tx.leg.deleteMany({ where: { tourId: next.id, fromStopId: { notIn: ownStopIds }, status: { not: "COMPLETED" } } });
        if (transfer && fromStop && next.stops[0]) await tx.leg.create({ data: { ...transfer, tourId: next.id, fromStopId: fromStop.id, toStopId: next.stops[0].id } });
        await tx.tour.update({ where: { id: next.id }, data: { previousTourId: fresh.previousTourId, planVersion: { increment: 1 } } });
      }
      await tx.alert.updateMany({ where: { tourId, resolvedAt: null }, data: { resolvedAt: now } });
      await tx.notification.updateMany({ where: { stopId: { in: stopIds }, acknowledgedAt: null }, data: { acknowledgedAt: now } });
      await tx.tour.update({ where: { id: tourId }, data: { status: "CANCELLED", completedAt: now, planVersion: { increment: 1 } } });
      if (fresh.status === "ACTIVE") await activateNextQueuedTour(tx, fresh.vehicleId, now);
      await tx.vehicle.update({ where: { id: fresh.vehicleId }, data: { operationVersion: { increment: 1 } } });
      await writeAuditLog(tx, actor, { action: "TOUR_CANCELLED", entityType: "Tour", entityId: tourId, vehicleId: fresh.vehicleId, tourId,
        metadata: { orderNumber: fresh.orderNumber, status: fresh.status, version: fresh.planVersion, nextTourId: next?.id ?? null }, createdAt: now });
      return tx.tour.findUniqueOrThrow({ where: { id: tourId }, include: tourInclude });
    });
  }

  async recordLoaded(stopId: string, now = new Date(), note?: string, actor?: AuditActor, options: StopEventOptions = {}): Promise<TourAggregate> {
    return this.recordStopEvent(stopId, "LOADED", now, note, actor, options);
  }

  async recordUnloaded(stopId: string, now = new Date(), note?: string, actor?: AuditActor, options: StopEventOptions = {}): Promise<TourAggregate> {
    return this.recordStopEvent(stopId, "UNLOADED", now, note, actor, options);
  }

  /**
   * Real GPS: the truck stood at the stop and then left the town. BELADEN/ENTLADEN is recorded at the moment it left the
   * stop's zone; the dispatcher gets a note with «Отменить».
   */
  async recordAutoStopEvent(input: AutoStopEventInput, actor?: AuditActor): Promise<TourAggregate> {
    const stop = await this.db.stop.findUniqueOrThrow({ where: { id: input.stopId } });
    return this.recordStopEvent(input.stopId, stop.type === "LOAD" ? "LOADED" : "UNLOADED", input.at, undefined, actor, { auto: { detectedAt: input.now, meta: input.meta } });
  }

  /**
   * Undo an automatic BELADEN/ENTLADEN while nothing has happened since: the stop, its legs and the tours go back to how they
   * were. History stays: the event remains and a compensating «…_REVERTED» event is written.
   */
  async revertAutoStopEvent(stopId: string, now = new Date(), actor?: AuditActor, reason?: string) {
    await this.db.$transaction(async (tx) => {
      const auto = await tx.operationEvent.findFirst({ where: { stopId, type: "STOP_EVENT_AUTO" }, orderBy: { createdAt: "desc" } });
      if (!auto) throw new TourPlanConflictError("Эту отметку поставил диспетчер, здесь её отменить нельзя.");
      const record = JSON.parse(auto.payloadJson) as AutoStopEventRecord;
      const at = new Date(record.at);
      const stop = await tx.stop.findUniqueOrThrow({ where: { id: stopId }, include: { tour: true } });
      if (!stop.completedAt || stop.completedAt.getTime() !== at.getTime()) throw new TourPlanConflictError("Автоотметка уже отменена или точка изменилась.");
      const vehicleId = stop.tour.vehicleId;
      const later = await tx.event.count({ where: { vehicleId, id: { not: record.eventId }, timestamp: { gte: at } } });
      const arrivedSince = await tx.stop.count({ where: { id: { not: stopId }, arrivedAt: { gte: at }, tour: { vehicleId } } });
      if (later || arrivedSince) throw new TourPlanConflictError("После автоотметки машина уже прибыла на следующую точку. Исправьте тур вручную.");
      const expected = record.activated ? "COMPLETED" : "ACTIVE";
      if (stop.tour.status !== expected) throw new TourPlanConflictError("Тур изменился после автоотметки. Исправьте его вручную.");
      if (record.activated) {
        const activated = await tx.tour.findUnique({ where: { id: record.activated.tourId } });
        if (activated?.status !== "ACTIVE") throw new TourPlanConflictError("Следующий тур изменился после автоотметки. Исправьте его вручную.");
      }

      const reopened = await tx.stop.updateMany({ where: { id: stopId, completedAt: at }, data: { completedAt: null } });
      if (!reopened.count) throw new TourPlanConflictError("Точка изменилась. Обновите страницу.");
      for (const leg of [...record.before.legs, ...(record.activated?.transferLeg ? [record.activated.transferLeg] : [])]) {
        await tx.leg.update({ where: { id: leg.id }, data: { status: leg.status, startedAt: leg.startedAt ? new Date(leg.startedAt) : null,
          finishedAt: leg.finishedAt ? new Date(leg.finishedAt) : null, drivePlan: leg.drivePlan } });
      }
      if (record.activated) await tx.tour.update({ where: { id: record.activated.tourId }, data: { status: "QUEUED", planVersion: { increment: 1 } } });
      await tx.tour.update({ where: { id: stop.tourId }, data: { status: record.before.tour.status, planVersion: { increment: 1 },
        completedAt: record.before.tour.completedAt ? new Date(record.before.tour.completedAt) : null,
        actualStartAt: record.before.tour.actualStartAt ? new Date(record.before.tour.actualStartAt) : null } });
      await tx.vehicle.update({ where: { id: vehicleId }, data: { clockState: record.before.clockState, currentTrailerPlate: record.before.trailerPlate, operationVersion: { increment: 1 } } });
      const note = reason?.trim() || "Автоматическая отметка отменена диспетчером";
      await tx.event.create({ data: { vehicleId, tourId: stop.tourId, stopId, type: `${record.eventType}_REVERTED`, timestamp: now, note } });
      await tx.notification.updateMany({ where: { stopId, type: "AUTO_STOP_EVENT", acknowledgedAt: null }, data: { acknowledgedAt: now } });
      await tx.operationEvent.create({ data: { vehicleId, tourId: stop.tourId, stopId, type: "STOP_EVENT_REVERTED", reason: note,
        payloadJson: JSON.stringify({ autoEventId: auto.id, eventType: record.eventType, at: record.at }), createdAt: now } });
      await writeAuditLog(tx, actor, { action: "STOP_EVENT_REVERTED", entityType: "Stop", entityId: stopId, vehicleId, tourId: stop.tourId, stopId,
        metadata: { event: record.eventType, at: record.at, reason: reason?.trim() || null }, createdAt: now });
    });
    return { ok: true };
  }

  async getCurrentPosition(vehicleId: string, now = new Date(), gps?: GpsFix | null): Promise<CurrentPosition> {
    const [vehicle, activeTour, activeLeg] = await Promise.all([
      this.db.vehicle.findUniqueOrThrow({ where: { id: vehicleId }, include: { issues: { where: { resolvedAt: null } } } }),
      this.db.tour.findFirst({
        where: { vehicleId, status: "ACTIVE" },
        include: { stops: { orderBy: { sequence: "asc" } } },
        orderBy: [{ queueIndex: "asc" }, { createdAt: "asc" }]
      }),
      this.db.leg.findFirst({
        where: { tour: { vehicleId, status: "ACTIVE" }, status: { in: ["ACTIVE", "ARRIVED"] } },
        include: { toStop: true },
        orderBy: { startedAt: "desc" }
      })
    ]);

    if (!activeLeg) {
      const stop = activeTour?.stops.find(item => item.arrivedAt && !item.completedAt);
      if (stop) return { ...emptyPosition("DWELL", activeTour?.id), state: "DWELL", status: "WAITING", position: toCoordinate(stop), coordinate: [stop.longitude, stop.latitude] };
      return this.idlePosition(vehicle, activeTour ? "WAITING_FOR_START" : "NO_ACTIVE_ROUTE", activeTour?.id);
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
    const arrived = progress >= 1 && activeLeg.status !== "COMPLETED";
    // Fresh Webfleet GPS beats the timer: distance, ETA and the drawn split come from where the truck really is,
    // and only a GPS arrival (arrivedAt) can put it at the stop.
    const projection = gps?.fresh && !activeLeg.toStop.arrivedAt ? projectOnLine(geometry, gps) : null;
    const lineMeters = projection?.totalMeters ?? 0;
    const legMeters = activeLeg.distanceMeters > 0 ? activeLeg.distanceMeters : lineMeters;
    const gpsRemainingMeters = projection && lineMeters > 0
      ? Math.round((lineMeters - projection.alongMeters) * (legMeters / lineMeters) + (projection.offMeters > OFF_ROUTE_METERS ? projection.offMeters : 0))
      : null;
    const gpsProgress = gpsRemainingMeters !== null && legMeters > 0 ? Math.max(0, Math.min(1, 1 - gpsRemainingMeters / legMeters)) : null;
    const gpsEta = gpsRemainingMeters !== null && !breakdown.blocked
      ? new Date(forecastDrive(clock.clockState, legMeters > 0 ? activeLeg.simulatedDurationSeconds * gpsRemainingMeters / legMeters : 0, now).endAt)
      : null;
    const split = projection ? splitAtProjection(geometry, projection) : splitGeometryAtProgress(geometry, progress);
    const shownEta = projection ? gpsEta : eta;
    const delayMinutes = activeLeg.toStop.appointmentAt ? calculateLateMinutes(shownEta, activeLeg.toStop.appointmentAt) : 0;
    const shownProgress = gpsProgress ?? progress;
    let travelledPrefix: Coordinate[] = [];
    let routeBreaks: number[] = [];
    let previousTravelledDistanceMeters = 0;
    let trafficSections: TrafficSection[] = [];
    let roadSections: RoadSection[] = [];
    let trafficCheckedAt: string | null = null;
    try {
      const details = JSON.parse(activeLeg.routeDetails ?? "{}") as { travelledGeometry?: Array<Coordinate | [number, number]>; travelledStitches?: unknown; previousTravelledDistanceMeters?: number;
        trafficSections?: TrafficSection[]; roadSections?: RoadSection[]; checkedAt?: string; providerStatus?: string;
        activeRoute?: { trafficSections?: TrafficSection[]; roadSections?: RoadSection[]; checkedAt?: string } };
      if (Array.isArray(details.travelledGeometry)) {
        const cleaned = cleanTravelled(details.travelledGeometry.map(point => Array.isArray(point) ? { longitude: point[0], latitude: point[1] } : point), geometry[0] ?? null, details.travelledStitches);
        travelledPrefix = cleaned.points;
        routeBreaks = cleaned.breaks;
      }
      previousTravelledDistanceMeters = details.previousTravelledDistanceMeters ?? 0;
      // Two shapes: a refreshed route lives in `activeRoute`, a freshly planned one at the top level.
      const source = details.activeRoute?.trafficSections ? details.activeRoute : details;
      if (Array.isArray(source.trafficSections)) trafficSections = source.trafficSections;
      const roads = details.activeRoute ? details.activeRoute.roadSections : details.roadSections;
      if (Array.isArray(roads)) roadSections = roads;
      trafficCheckedAt = source.checkedAt ?? null;
    } catch { /* Legacy routes need no prefix. */ }
    // TomTom indices refer to the stored leg geometry; the line sent out starts with the travelled prefix.
    const trafficSegments = trafficSections
      .filter(section => Number.isInteger(section.start) && Number.isInteger(section.end) && section.end > section.start && section.end < geometry.length)
      .map(section => ({ from: section.start + travelledPrefix.length, to: section.end + travelledPrefix.length, level: section.level, delaySeconds: section.delaySeconds, speedKmh: section.speedKmh }));
    const roadSegments = roadSections
      .filter(section => Number.isInteger(section.start) && Number.isInteger(section.end) && section.end > section.start && section.end < geometry.length && typeof section.road === "string")
      .map(section => ({ from: section.start + travelledPrefix.length, to: section.end + travelledPrefix.length, road: section.road }));

    return {
      state: activeLeg.toStop.arrivedAt ? "DWELL" : arrived && !projection ? "ANGEKOMMEN_WARTET_AUF_BESTAETIGUNG" : "UNTERWEGS",
      status: breakdown.blocked || activeLeg.toStop.arrivedAt ? "WAITING" : arrived && !projection ? "ARRIVED" : clock.paused && !projection ? "WAITING" : "MOVING",
      disclaimer: CALCULATED_POSITION_DISCLAIMER,
      position,
      coordinate: position ? [position.longitude, position.latitude] : null,
      tourId: activeLeg.tourId,
      legId: activeLeg.id,
      // Depends only on the drawn line: the leg row is touched on every background check.
      geometryVersion: geometryFingerprint(activeLeg.id, activeLeg.routeGeometry, activeLeg.routeDetails),
      startedAt: activeLeg.startedAt?.toISOString() ?? null,
      delayMinutes,
      routeGeometry: [...travelledPrefix, ...geometry].map(toLonLat),
      travelledGeometry: [...travelledPrefix, ...split.travelledGeometry].map(toLonLat),
      routeBreaks,
      remainingGeometry: split.remainingGeometry.map(toLonLat),
      trafficSegments,
      roadSegments,
      trafficCheckedAt: trafficSegments.length ? trafficCheckedAt : null,
      progress: shownProgress,
      distanceTravelledMeters: previousTravelledDistanceMeters + (gpsRemainingMeters !== null ? Math.max(0, legMeters - gpsRemainingMeters) : calculateDistanceTravelled(activeLeg.distanceMeters, progress)),
      remainingDistanceMeters: gpsRemainingMeters ?? calculateRemainingDistance(activeLeg.distanceMeters, progress),
      eta: shownEta?.toISOString() ?? null,
      etaSource: projection ? "GPS" : "CALCULATED",
      offRouteMeters: projection ? Math.round(projection.offMeters) : null,
      predictedArrival: arrived && !activeLeg.toStop.arrivedAt
    };
  }

  private async idlePosition(
    vehicle: Pick<Vehicle, "id" | "manualPositionLatitude" | "manualPositionLongitude" | "manualPositionAt">,
    state: CurrentPosition["state"],
    tourId?: string
  ): Promise<CurrentPosition> {
    const lastStop = await this.db.stop.findFirst({
      where: { tour: { vehicleId: vehicle.id }, completedAt: { not: null } },
      orderBy: { completedAt: "desc" }
    });
    const hasManual = vehicle.manualPositionLatitude != null && vehicle.manualPositionLongitude != null;
    const manualIsNewer = !lastStop?.completedAt || !vehicle.manualPositionAt || vehicle.manualPositionAt >= lastStop.completedAt;
    if (hasManual && manualIsNewer) {
      const position = { latitude: vehicle.manualPositionLatitude!, longitude: vehicle.manualPositionLongitude! };
      return { ...emptyPosition(state, tourId), position, coordinate: [position.longitude, position.latitude],
        positionSource: "MANUAL", disclaimer: MANUAL_POSITION_DISCLAIMER };
    }
    if (lastStop) {
      return { ...emptyPosition(state, tourId), position: toCoordinate(lastStop), coordinate: [lastStop.longitude, lastStop.latitude],
        positionSource: "CALCULATED", disclaimer: LAST_STOP_POSITION_DISCLAIMER };
    }
    return emptyPosition(state, tourId);
  }

  private async recordStopEvent(
    stopId: string,
    eventType: "LOADED" | "UNLOADED",
    now: Date,
    note?: string,
    actor?: AuditActor,
    options: StopEventOptions = {},
  ): Promise<TourAggregate> {
    const context = await readDepartureContext(this.db, stopId);
    // Without a GPS arrival the dispatcher's BELADEN/ENTLADEN also records the arrival at the same moment.
    const arriveNow = Boolean(options.arriveWithEvent && !context.stop.arrivedAt);
    assertStopActionAllowed(context.stop.completedAt, context.stop.tour.status, arriveNow ? now : context.stop.arrivedAt);
    assertStopEventTime(now, context.stop.arrivedAt);
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
      assertStopActionAllowed(stop.completedAt, stop.tour.status, arriveNow ? now : stop.arrivedAt);
      if (stop.tour.stops.some((candidate) => candidate.sequence < stop.sequence && !candidate.completedAt)) {
        throw new TourPlanConflictError("Сначала необходимо завершить предыдущие точки.");
      }
      // What the automatic event changes, so that «Отменить» can put it back exactly.
      const before: AutoStopEventRecord["before"] | null = options.auto ? {
        clockState: stop.tour.vehicle.clockState, trailerPlate: stop.tour.vehicle.currentTrailerPlate,
        tour: { status: stop.tour.status, completedAt: stop.tour.completedAt?.toISOString() ?? null, actualStartAt: stop.tour.actualStartAt?.toISOString() ?? null },
        legs: stop.tour.legs.filter((leg) => leg.toStopId === stop.id || leg.fromStopId === stop.id).map(legState)
      } : null;
      if (arriveNow) {
        const arrived = await tx.stop.updateMany({ where: { id: stop.id, arrivedAt: null }, data: { arrivedAt: now } });
        if (!arrived.count) throw new TourPlanConflictError("Прибытие уже зафиксировано. Обновите страницу.");
        await tx.operationEvent.create({ data: { vehicleId: stop.tour.vehicleId, tourId: stop.tourId, stopId: stop.id, type: "ARRIVAL_CONFIRMED",
          payloadJson: JSON.stringify({ arrivedAt: now, source: "WITH_STOP_EVENT", event: eventType }), createdAt: now } });
        await writeAuditLog(tx, actor, { action: "ARRIVAL_CONFIRMED", entityType: "Stop", entityId: stop.id, vehicleId: stop.tour.vehicleId,
          tourId: stop.tourId, stopId: stop.id, metadata: { arrivedAt: now.toISOString(), source: "WITH_STOP_EVENT", event: eventType }, createdAt: now });
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
      // The question «loaded after leaving?» is answered once the event is recorded.
      await tx.notification.updateMany({ where: { stopId: stop.id, type: 'STOP_DEPARTED', acknowledgedAt: null }, data: { acknowledgedAt: now } });
      const recorded = await tx.event.create({
        data: {
          vehicleId: stop.tour.vehicleId,
          tourId: stop.tourId,
          stopId: stop.id,
          type: eventType,
          timestamp: now,
          note: options.auto ? "Автоматически по GPS Webfleet: машина выехала из города" : note
        }
      });
      await writeAuditLog(tx, actor, { action: eventType, entityType: "Stop", entityId: stop.id,
        vehicleId: stop.tour.vehicleId, tourId: stop.tourId, stopId: stop.id,
        metadata: options.auto ? { source: "WEBFLEET_AUTO", ...options.auto.meta } : note ? { note } : undefined, createdAt: now });

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
      let activated: Awaited<ReturnType<typeof activateNextQueuedTour>> = null;
      if (outgoingLeg) {
        await tx.leg.update({
          where: { id: outgoingLeg.id },
          data: { status: "ACTIVE", startedAt: now, drivePlan: JSON.stringify(makePersistedDrivePlan(clock, outgoingLeg.simulatedDurationSeconds, now)) }
        });
      } else {
        await tx.tour.update({ where: { id: stop.tourId }, data: { status: "COMPLETED", completedAt: now } });
        activated = await activateNextQueuedTour(tx, stop.tour.vehicleId, now);
      }

      if (options.auto && before) {
        const record: AutoStopEventRecord = { eventId: recorded.id, eventType, at: now.toISOString(), before,
          activated: activated ? { tourId: activated.tour.id, transferLeg: activated.transferLeg } : null, meta: options.auto.meta };
        await tx.operationEvent.create({ data: { vehicleId: stop.tour.vehicleId, tourId: stop.tourId, stopId: stop.id, type: "STOP_EVENT_AUTO",
          reason: "Выехала из города после стоянки на точке", payloadJson: JSON.stringify(record), createdAt: options.auto.detectedAt } });
        const done = eventType === "LOADED" ? "BELADEN" : "ENTLADEN";
        const place = stop.city || stop.address;
        await tx.notification.create({ data: {
          dedupKey: `auto-stop-event:${stop.id}:${recorded.id}`, vehicleId: stop.tour.vehicleId, stopId: stop.id, type: "AUTO_STOP_EVENT",
          message: `LKW ${stop.tour.vehicle.vehicleNumber} выехала из ${place} — вероятно ${eventType === "LOADED" ? "загружена" : "выгружена"}. ${done} записан автоматически на ${berlinClock(now)} (выезд с точки по GPS Webfleet). Если это ошибка, отмените.`,
          payloadJson: JSON.stringify({ stopType: stop.type, at: now.toISOString(), source: "WEBFLEET_AUTO", ...options.auto.meta })
        } });
      }

      return tx.tour.findUniqueOrThrow({ where: { id: stop.tourId }, include: tourInclude });
    });
  }
}

export type StopEventOptions = { arriveWithEvent?: boolean; auto?: { detectedAt: Date; meta: AutoStopEventInput["meta"] } };

type LegState = { id: string; status: string; startedAt: string | null; finishedAt: string | null; drivePlan: string | null };
type AutoStopEventRecord = {
  eventId: string;
  eventType: "LOADED" | "UNLOADED";
  at: string;
  before: { clockState: string | null; trailerPlate: string | null; tour: { status: string; completedAt: string | null; actualStartAt: string | null }; legs: LegState[] };
  activated: { tourId: string; transferLeg: LegState | null } | null;
  meta: AutoStopEventInput["meta"];
};

function legState(leg: { id: string; status: string; startedAt: Date | null; finishedAt: Date | null; drivePlan: string | null }): LegState {
  return { id: leg.id, status: leg.status, startedAt: leg.startedAt?.toISOString() ?? null, finishedAt: leg.finishedAt?.toISOString() ?? null, drivePlan: leg.drivePlan };
}

function berlinClock(value: Date) {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(value);
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

type SavedStopFields = {
  id: string; company: string | null; sourceAddress: string | null; resolvedAddress: string | null; geocodePrecision: string | null; geocodeProvider: string | null;
  appointmentWindowStartAt: Date | null; appointmentWindowEndAt: Date | null; loadingMeters: number | null; referenceNumbersJson: string | null; instructions: string | null;
  plannedAt?: Date | null; departureDeadlineAt?: Date | null;
};

/**
 * The edit form shows only some fields. Anything it leaves out (LDM, references, instructions, time windows,
 * trailer, Tourbemerkung) keeps its saved value instead of being wiped when the stops are rebuilt.
 */
export function keepSavedTourFields(
  input: UpdateFutureTourInput,
  saved: { trailerPlate: string | null; tourRemarks: string | null; stops: SavedStopFields[] }
): UpdateFutureTourInput {
  const byId = new Map(saved.stops.map((stop) => [stop.id, stop]));
  return {
    ...input,
    trailerPlate: input.trailerPlate === undefined ? saved.trailerPlate : input.trailerPlate,
    tourRemarks: input.tourRemarks === undefined ? saved.tourRemarks : input.tourRemarks,
    stops: input.stops.map((stop) => {
      const old = stop.id ? byId.get(stop.id) : undefined;
      if (!old) return stop;
      const keepWindow = !stop.appointmentAt && stop.appointmentWindowStartAt === undefined && stop.appointmentWindowEndAt === undefined;
      return {
        ...stop,
        company: stop.company ?? old.company ?? undefined,
        sourceAddress: stop.sourceAddress === undefined ? old.sourceAddress : stop.sourceAddress,
        resolvedAddress: stop.resolvedAddress === undefined ? old.resolvedAddress : stop.resolvedAddress,
        geocodePrecision: stop.geocodePrecision === undefined ? (old.geocodePrecision as CreateTourInput["stops"][number]["geocodePrecision"]) : stop.geocodePrecision,
        geocodeProvider: stop.geocodeProvider === undefined ? old.geocodeProvider : stop.geocodeProvider,
        appointmentWindowStartAt: keepWindow ? old.appointmentWindowStartAt?.toISOString() ?? null : stop.appointmentWindowStartAt,
        appointmentWindowEndAt: keepWindow ? old.appointmentWindowEndAt?.toISOString() ?? null : stop.appointmentWindowEndAt,
        loadingMeters: stop.loadingMeters === undefined ? old.loadingMeters : stop.loadingMeters,
        referenceNumbers: stop.referenceNumbers === undefined ? parseReferenceNumbers(old.referenceNumbersJson) : stop.referenceNumbers,
        instructions: stop.instructions === undefined ? old.instructions : stop.instructions,
        plannedAt: stop.plannedAt === undefined ? old.plannedAt?.toISOString() ?? null : stop.plannedAt,
        departureDeadlineAt: stop.departureDeadlineAt === undefined ? old.departureDeadlineAt?.toISOString() ?? null : stop.departureDeadlineAt
      };
    })
  };
}

function parseReferenceNumbers(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
  } catch {
    return null;
  }
}

/** The tour's customer: the one its Auftrag was read for, else the customer of the truck's line; the line only when it is that customer's. */
async function tourCustomer(tx: Prisma.TransactionClient, customerLineId: string | null | undefined, customerId: string | null | undefined) {
  const line = customerLineId ? await tx.customerLine.findUnique({ where: { id: customerLineId }, select: { id: true, customerId: true } }) : null;
  const customer = customerId ?? line?.customerId ?? null;
  return { customerId: customer, customerLineId: line && line.customerId === customer ? line.id : null };
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
  const insertion = current ? null : await chooseQueueInsertion(db, openTours, tourStartFromStops(input.stops));
  const placement = current?.vehicleId === input.vehicleId
    ? { status: current.status, previousTourId: current.previousTourId, queueIndex: current.queueIndex }
    : insertion
      ? { status: insertion.index === 0 ? "ACTIVE" as const : "QUEUED" as const,
          previousTourId: insertion.index === 0 ? insertion.next.previousTourId ?? undefined : openTours[insertion.index - 1].id,
          queueIndex: insertion.next.queueIndex }
      : determineNewTourPlacement(openTours);
  // The first tour of a vehicle has no transfer leg; when a tour moves to the front it starts without one too.
  const transferFromId = insertion?.index === 0 ? undefined : placement.previousTourId;
  const previousTour = transferFromId
    ? await db.tour.findUnique({
        where: { id: transferFromId },
        include: { stops: { orderBy: { sequence: "desc" }, take: 1 } }
      })
    : null;

  return { vehicle, openTours, current, previousTour, ...placement, insertBefore: insertion?.next ?? null };
}

function assertPlanningContextUnchanged(
  expected: Awaited<ReturnType<typeof readPlanningContext>>,
  actual: Awaited<ReturnType<typeof readPlanningContext>>
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new TourPlanConflictError("План маршрута изменился во время расчёта. Сохраните повторно.");
  }
}

function assertImportedTourVehicle(tour: TourAggregate, vehicleId: string): TourAggregate {
  if (tour.vehicleId !== vehicleId) {
    throw Object.assign(
      new Error(`Этот Auftrag уже прикреплён к LKW ${tour.vehicle.vehicleNumber}. Откройте существующий тур или измените его вручную.`),
      { statusCode: 409 }
    );
  }
  return tour;
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
        sourceAddress: stop.sourceAddress?.trim() || stop.address,
        resolvedAddress: stop.resolvedAddress?.trim() || null,
        geocodePrecision: stop.geocodePrecision ?? null,
        geocodeProvider: stop.geocodeProvider?.trim() || null,
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
        serviceMaxMinutes: normalizeServiceMinutes(stop.serviceMaxMinutes, 120),
        plannedAt: toNullableDate(stop.plannedAt),
        departureDeadlineAt: toNullableDate(stop.departureDeadlineAt),
        // VW, BLG, Mercedes, Seifert, Audi, Rudolph, Rhenus always send a Termin: until it arrives the stop shows «Termin нужен».
        terminRequired: !stop.appointmentAt && !stop.appointmentWindowStartAt && requiresTermin(`${stop.company ?? ""} ${stop.address}`)
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

/** A tour has begun once there is an arrival, a completed stop or a BELADEN/ENTLADEN event. */
export function tourHasBegun(tour: { events: unknown[]; stops: Array<{ arrivedAt: Date | null; completedAt: Date | null }> }) {
  return tour.events.length > 0 || tour.stops.some((stop) => stop.arrivedAt || stop.completedAt);
}

function assertTourCancellable(tour: { status: string; planVersion: number; events: unknown[]; stops: Array<{ arrivedAt: Date | null; completedAt: Date | null }> }, version?: number) {
  if (version !== undefined && tour.planVersion !== version) throw new TourPlanConflictError("Тур изменился. Обновите страницу.");
  if (tour.status !== "QUEUED" && tour.status !== "ACTIVE") throw new TourPlanConflictError("Этот тур уже завершён или отменён.");
  if (tourHasBegun(tour)) throw new TourPlanConflictError("Тур начат: есть прибытие или BELADEN/ENTLADEN. Удалить нельзя.");
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

/** When a tour starts: the first stop's exact appointment or the start of its window. */
export function tourStartFromStops(stops: CreateTourInput["stops"]): Date | null {
  const first = [...stops].sort((a, b) => a.sequence - b.sequence)[0];
  const value = first?.appointmentAt ?? first?.appointmentWindowStartAt ?? null;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

type QueueNeighbour = {
  id: string; status: string; queueIndex: number; previousTourId: string | null;
  firstStop: Stop | null;
};

/**
 * Where a new tour belongs in the vehicle's queue: before the first tour that loads later.
 * A tour that already began (arrival, event or a leg under way) is never displaced; undated tours keep their place.
 */
export async function chooseQueueInsertion(
  db: Prisma.TransactionClient,
  openTours: Array<Pick<Tour, "id" | "status" | "plannedStartAt" | "previousTourId"> & Partial<Pick<Tour, "queueIndex">>>,
  start: Date | null
): Promise<{ index: number; next: QueueNeighbour } | null> {
  if (!start) return null;
  for (const [index, tour] of openTours.entries()) {
    const details = await db.tour.findUnique({ where: { id: tour.id }, include: { stops: { orderBy: { sequence: "asc" } }, legs: true, events: { take: 1 } } });
    if (!details) continue;
    const stops = details.stops ?? [];
    const began = (details.events ?? []).length > 0 || stops.some((stop) => stop.arrivedAt || stop.completedAt)
      || (details.legs ?? []).some((leg) => leg.status === "ACTIVE" || leg.status === "ARRIVED" || leg.status === "COMPLETED");
    if (tour.status === "ACTIVE" && began) continue;
    const tourStart = tour.plannedStartAt ?? stops[0]?.appointmentAt ?? stops[0]?.appointmentWindowStartAt ?? null;
    if (tourStart && tourStart.getTime() > start.getTime()) {
      return { index, next: { id: tour.id, status: tour.status, queueIndex: tour.queueIndex ?? index, previousTourId: tour.previousTourId, firstStop: stops[0] ?? null } };
    }
  }
  return null;
}

async function prepareTransferLeg(routingProvider: RoutingProvider, from: Coordinate, to: Stop, maxSpeedKmh: number) {
  const route = await routingProvider.calculateRoute(toCoordinate(from), toCoordinate(to));
  const simulatedDurationSeconds = calculateSimulatedDuration(route.distanceMeters, route.durationSeconds, maxSpeedKmh);
  return {
    distanceMeters: route.distanceMeters,
    routeGeometry: serializeGeometry(route.geometry),
    routingDurationSeconds: route.durationSeconds,
    simulatedDurationSeconds,
    drivePlan: JSON.stringify(buildSimpleDrivePlan(simulatedDurationSeconds)),
    routeDetails: JSON.stringify(route)
  };
}

/** The tour after an inserted one now starts from the inserted tour's last stop and waits in the queue. */
async function relinkFollowingTour(
  tx: Prisma.TransactionClient,
  insertedTourId: string,
  next: QueueNeighbour,
  transfer: Awaited<ReturnType<typeof prepareTransferLeg>>
) {
  const lastStop = await tx.stop.findFirstOrThrow({ where: { tourId: insertedTourId }, orderBy: { sequence: "desc" } });
  const nextStops = await tx.stop.findMany({ where: { tourId: next.id }, select: { id: true } });
  const ownStopIds = nextStops.map((stop) => stop.id);
  if (next.firstStop) {
    await tx.leg.deleteMany({ where: { tourId: next.id, toStopId: next.firstStop.id, fromStopId: { notIn: ownStopIds }, status: { not: "COMPLETED" } } });
    await tx.leg.create({ data: { ...transfer, tourId: next.id, fromStopId: lastStop.id, toStopId: next.firstStop.id } });
  }
  await tx.tour.update({ where: { id: next.id }, data: { status: "QUEUED", previousTourId: insertedTourId, planVersion: { increment: 1 } } });
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
  alerts: { orderBy: { createdAt: "desc" } },
  // Only the link to the saved Auftrag: the bytes are served by the file route.
  document: { select: { id: true, filename: true, mimeType: true } }
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

async function activateNextQueuedTour(tx: Prisma.TransactionClient, vehicleId: string, startedAt: Date): Promise<{ tour: Tour; transferLeg: LegState | null } | null> {
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
      return { tour: activatedTour, transferLeg: legState(transferLeg) };
    }
  }
  return { tour: activatedTour, transferLeg: null };
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

/** BELADEN/ENTLADEN times go into immutable history: never in the future and never before the arrival. */
export function assertStopEventTime(at: Date, arrivedAt: Date | null, clock = new Date()): void {
  if (!Number.isFinite(at.getTime())) throw new TourPlanConflictError("Некорректное время события.");
  if (at.getTime() > clock.getTime() + 60_000) throw new TourPlanConflictError("Время загрузки или выгрузки не может быть в будущем.");
  if (arrivedAt && at < arrivedAt) throw new TourPlanConflictError("Время загрузки или выгрузки не может быть раньше прибытия.");
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

function geometryFingerprint(legId: string, routeGeometry: string | null, routeDetails: string | null): string {
  let travelled = "";
  try {
    const details = JSON.parse(routeDetails ?? "{}") as { travelledGeometry?: unknown; trafficSections?: unknown; roadSections?: unknown;
      activeRoute?: { trafficSections?: unknown; roadSections?: unknown } };
    travelled = JSON.stringify([details.travelledGeometry ?? null, details.activeRoute?.trafficSections ?? details.trafficSections ?? null,
      details.activeRoute?.roadSections ?? details.roadSections ?? null]);
  } catch { /* Legacy details. */ }
  return `${legId}:${createHash("sha1").update(routeGeometry ?? "").update("|").update(travelled).digest("hex").slice(0, 16)}`;
}
