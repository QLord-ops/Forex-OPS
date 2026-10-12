import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Coordinate, CurrentPosition, RouteResult } from '../domain.js';
import type { RoutingProvider } from './routing.js';
import { calculateSimulatedDuration } from './simulation.js';
import { TourService, snapshotVehicleClock, rebaseActiveLeg } from './tours.js';
import { forecastDrive, applyStopTime, type ClockState } from './vehicle-clock.js';

export type ReplanStop = { id?: string; type: 'LOAD' | 'UNLOAD'; address: string; company?: string | null; city?: string | null; appointmentAt?: string | null; serviceMinMinutes?: number; serviceMaxMinutes?: number; latitude?: number; longitude?: number };
export type ReplanInput = { version: number; futureStops: ReplanStop[]; origin?: Coordinate };
type ResolvedStop = ReplanStop & Coordinate & { id: string };
type PlannedLeg = { tourId: string; fromStopId: string; toStopId: string; route: RouteResult; duration: number; active: boolean };
type StoredPlan = { context: string; stops: ResolvedStop[]; legs: PlannedLeg[]; affectedTourIds: string[]; position: CurrentPosition; origin: Coordinate | null };
export class RouteReplanConflictError extends Error { readonly statusCode = 409; }
const ReplanConflict = RouteReplanConflictError;
const include = { stops: { orderBy: { sequence: 'asc' as const } }, legs: { orderBy: { createdAt: 'asc' as const } }, events: { orderBy: { timestamp: 'asc' as const } } };
function roads(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const numbers = (value as { roadNumbers?: unknown }).roadNumbers;
  return Array.isArray(numbers) ? numbers.filter((v): v is string => typeof v === 'string') : [];
}
function storedRoads(value: string | null): string[] {
  try { return roads(JSON.parse(value ?? 'null')); } catch { return []; }
}
type ScheduleStop = { id: string; appointmentAt?: string | Date | null; serviceMinMinutes?: number; serviceMaxMinutes?: number; arrivedAt?: Date | null };
function forecastQueue(clock: ClockState, now: Date, legs: { toStopId: string; duration: number }[], stops: ScheduleStop[], arrived?: ScheduleStop) {
  let early = clock, late = clock, earlyAt = now, lateAt = now;
  const windows: { stopId: string; earliest: string; latest: string }[] = [];
  const service = (stop?: ScheduleStop) => {
    const elapsed = stop?.arrivedAt ? Math.max(0, (now.getTime() - stop.arrivedAt.getTime()) / 1000) : 0;
    const appointment = stop?.appointmentAt ? new Date(stop.appointmentAt).getTime() : 0;
    const min = Math.max(0, (stop?.serviceMinMinutes ?? 60) * 60 - elapsed) + Math.max(0, (appointment - earlyAt.getTime()) / 1000);
    const max = Math.max(0, (stop?.serviceMaxMinutes ?? 120) * 60 - elapsed) + Math.max(0, (appointment - lateAt.getTime()) / 1000);
    early = applyStopTime(early, min, earlyAt).state; late = applyStopTime(late, max, lateAt).state;
    earlyAt = new Date(earlyAt.getTime() + min * 1000); lateAt = new Date(lateAt.getTime() + max * 1000);
  };
  if (arrived) service(arrived);
  for (const leg of legs) {
    const first = forecastDrive(early, leg.duration, earlyAt), second = forecastDrive(late, leg.duration, lateAt);
    earlyAt = new Date(first.endAt); lateAt = new Date(second.endAt); early = first.state; late = second.state;
    windows.push({ stopId: leg.toStopId, earliest: earlyAt.toISOString(), latest: lateAt.toISOString() });
    service(stops.find(s => s.id === leg.toStopId));
  }
  return windows;
}

export class ReplanningService {
  constructor(private readonly db: PrismaClient, private readonly routing: RoutingProvider,
    private readonly getPosition: (vehicleId: string, now: Date) => Promise<CurrentPosition> = (id, now) => new TourService(db, routing).getCurrentPosition(id, now),
    private readonly checkpoint?: (tx: Prisma.TransactionClient, vehicleId: string, now: Date) => Promise<void>) {}

  private async context(db: PrismaClient | Prisma.TransactionClient, tourId: string) {
    const tour = await db.tour.findUniqueOrThrow({ where: { id: tourId }, include });
    const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: tour.vehicleId } });
    const tours = await db.tour.findMany({ where: { vehicleId: vehicle.id, status: { in: ['ACTIVE', 'QUEUED'] } }, include, orderBy: [{ queueIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
    return { tour, vehicle, tours };
  }

  async preview(tourId: string, input: ReplanInput, now = new Date()) {
    const context = await this.context(this.db, tourId);
    const { tour, vehicle, tours } = context;
    if (tour.status !== 'ACTIVE' || tour.planVersion !== input.version) throw new ReplanConflict('Требуется актуальная версия маршрута.');
    if (!input.futureStops.length || input.futureStops.length > 100) throw new ReplanConflict('Необходимо указать от 1 до 100 будущих точек.');
    const completed = tour.stops.filter(s => s.completedAt);
    const pending = tour.stops.filter(s => !s.completedAt);
    const ids = input.futureStops.flatMap(s => s.id ? [s.id] : []);
    if (new Set(ids).size !== ids.length || ids.some(id => !pending.some(s => s.id === id))) throw new ReplanConflict('Неизвестная или уже завершённая точка.');
    const arrived = pending.find(s => s.arrivedAt);
    if (arrived) {
      const first = input.futureStops[0];
      if (first.id !== arrived.id || first.type !== arrived.type || first.address !== arrived.address || (first.latitude !== undefined && first.latitude !== arrived.latitude) || (first.longitude !== undefined && first.longitude !== arrived.longitude) || (first.appointmentAt ?? null) !== (arrived.appointmentAt?.toISOString() ?? null)) throw new ReplanConflict('Подтверждённую текущую точку нельзя изменить или удалить.');
    }
    if ((completed.some(s => s.type === 'LOAD') || input.futureStops.some(s => s.type === 'LOAD')) && !input.futureStops.some(s => s.type === 'UNLOAD')) throw new ReplanConflict('Необходимую выгрузку нужно сохранить.');
    const position = await this.getPosition(vehicle.id, now);
    const origin = input.origin ?? position.position ?? completed.at(-1) ?? null;
    if (origin && (!Number.isFinite(origin.latitude) || Math.abs(origin.latitude) > 90 || !Number.isFinite(origin.longitude) || Math.abs(origin.longitude) > 180)) throw new ReplanConflict('Некорректная позиция.');
    const stops: ResolvedStop[] = [];
    for (const stop of input.futureStops) {
      const min = stop.serviceMinMinutes ?? 60, max = stop.serviceMaxMinutes ?? 120;
      if (!stop.address.trim() || !['LOAD', 'UNLOAD'].includes(stop.type) || !Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > 10080 || (stop.appointmentAt && !Number.isFinite(Date.parse(stop.appointmentAt)))) throw new ReplanConflict('Некорректные данные точки.');
      const point = stop.latitude !== undefined && stop.longitude !== undefined ? stop as Coordinate : await this.routing.geocode(stop.address);
      if (!Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) throw new ReplanConflict('Некорректные координаты.');
      stops.push({ ...stop, id: stop.id ?? randomUUID(), latitude: point.latitude, longitude: point.longitude, serviceMinMinutes: min, serviceMaxMinutes: max });
    }
    const legs: PlannedLeg[] = [];
    const append = async (id: string, from: Coordinate & { id: string }, to: ResolvedStop | (Coordinate & { id: string }), active: boolean) => {
      const route = await this.routing.calculateRoute(from, to);
      legs.push({ tourId: id, fromStopId: from.id, toStopId: to.id, route, duration: calculateSimulatedDuration(route.distanceMeters, route.durationSeconds, vehicle.maxSpeedKmh), active });
    };
    // A moving replacement begins at the calculated/confirmed position. The old
    // complete geometry and travelled prefix remain in the immutable revision.
    const oldActive = tour.legs.find(l => ['ACTIVE', 'ARRIVED'].includes(l.status));
    if (origin && !arrived && (oldActive || completed.length)) await append(tourId, { ...origin, id: oldActive?.fromStopId ?? completed.at(-1)!.id }, stops[0], Boolean(oldActive));
    for (let i = 1; i < stops.length; i++) await append(tourId, stops[i - 1], stops[i], false);
    let last = stops.at(-1)!;
    const downstream = tours.slice(tours.findIndex(t => t.id === tourId) + 1);
    for (const queued of downstream) {
      if (queued.status !== 'QUEUED' || queued.stops.some(s => s.completedAt || s.arrivedAt) || queued.events.length) throw new ReplanConflict('Следующий маршрут уже начат.');
      for (const stop of queued.stops) {
        await append(queued.id, last, stop, false);
        last = { ...stop, type: stop.type as 'LOAD' | 'UNLOAD', appointmentAt: stop.appointmentAt?.toISOString() ?? null };
      }
    }
    const affectedTourIds = [tourId, ...downstream.map(t => t.id)];
    const plan: StoredPlan = { context: JSON.stringify(context), stops, legs, affectedTourIds, position, origin };
    if (JSON.stringify(await this.context(this.db, tourId)) !== plan.context) throw new ReplanConflict('Маршрут изменился во время расчёта.');
    const preview = await this.db.routePreview.create({ data: { tourId, version: input.version, vehicleVersion: vehicle.operationVersion, inputJson: JSON.stringify(input), planJson: JSON.stringify(plan), expiresAt: new Date(now.getTime() + 10 * 60_000) } });
    const beforeLegs = tours.filter(t => affectedTourIds.includes(t.id)).flatMap(t => t.legs.filter(l => l.status !== 'COMPLETED'));
    const snapshot = snapshotVehicleClock(vehicle, oldActive ?? null, now);
    const etaWindows = forecastQueue(snapshot.clockState, now, legs, [...stops, ...downstream.flatMap(t => t.stops)], arrived ?? (!oldActive && !completed.length ? stops[0] : undefined));
    const beforeSchedule = beforeLegs.filter(l => l.toStopId !== arrived?.id).map(l => ({ toStopId: l.toStopId, duration: Math.max(0, l.simulatedDurationSeconds - (l.id === oldActive?.id ? snapshot.driveElapsedSeconds : 0)) }));
    const beforeWindows = forecastQueue(snapshot.clockState, now, beforeSchedule, tours.flatMap(t => t.stops), arrived ?? (!oldActive && !completed.length ? pending[0] : undefined));
    return { id: preview.id, version: preview.version, expiresAt: preview.expiresAt.toISOString(), stops, affectedTourIds,
      etaWindows,
      before: { distanceMeters: Math.max(0, beforeLegs.reduce((n, l) => n + l.distanceMeters, 0) - position.distanceTravelledMeters), durationSeconds: beforeSchedule.reduce((n, l) => n + l.duration, 0), roads: [...new Set(beforeLegs.flatMap(l => storedRoads(l.routeDetails)))], etaWindows: beforeWindows },
      after: { distanceMeters: legs.reduce((n, l) => n + l.route.distanceMeters, 0), durationSeconds: legs.reduce((n, l) => n + l.duration, 0), roads: [...new Set(legs.flatMap(l => roads(l.route)))], etaWindows } };
  }

  async apply(tourId: string, input: { previewId: string; version: number }, now = new Date()) {
    return this.db.$transaction(async tx => {
      const preview = await tx.routePreview.findUniqueOrThrow({ where: { id: input.previewId } });
      if (preview.tourId !== tourId || preview.version !== input.version || preview.appliedAt || preview.expiresAt <= now) throw new ReplanConflict('Предварительный расчёт истёк или уже применён.');
      const plan = JSON.parse(preview.planJson) as StoredPlan;
      const context = await this.context(tx, tourId);
      if (JSON.stringify(context) !== plan.context) throw new ReplanConflict('Предварительный расчёт устарел: рассчитайте маршрут заново.');
      await this.checkpoint?.(tx, context.vehicle.id, now);
      const currentLeg = context.tour.legs.find(l => ['ACTIVE', 'ARRIVED'].includes(l.status));
      const clock = snapshotVehicleClock(context.vehicle, currentLeg ?? null, now).clockState;
      const arrived = context.tour.stops.find(s => s.arrivedAt && !s.completedAt);
      for (const tour of context.tours.filter(t => plan.affectedTourIds.includes(t.id))) {
        await tx.routeRevision.create({ data: { tourId: tour.id, version: tour.planVersion, snapshotJson: JSON.stringify({ tour, position: plan.position, clockState: context.vehicle.clockState }) } });
        await tx.leg.deleteMany({ where: { tourId: tour.id, status: { not: 'COMPLETED' }, ...(arrived && currentLeg ? { id: { not: currentLeg.id } } : {}) } });
        await tx.tour.update({ where: { id: tour.id }, data: { planVersion: { increment: 1 } } });
      }
      const preserved = context.tour.stops.filter(s => s.completedAt);
      const keepIds = [...preserved.map(s => s.id), ...plan.stops.map(s => s.id)];
      // No completed leg/event may be removed through a stop cascade.
      const protectedIds = context.tours.flatMap(t => t.legs.filter(l => l.status === 'COMPLETED').flatMap(l => [l.fromStopId, l.toStopId]));
      if (context.tour.stops.some(s => !keepIds.includes(s.id) && protectedIds.includes(s.id))) throw new ReplanConflict('Точка относится к уже пройденному участку.');
      await tx.stop.deleteMany({ where: { tourId, id: { notIn: keepIds } } });
      for (const stop of context.tour.stops.filter(s => !s.completedAt && keepIds.includes(s.id))) await tx.stop.update({ where: { id: stop.id }, data: { sequence: -100000 - stop.sequence } });
      let sequence = Math.max(0, ...preserved.map(s => s.sequence));
      for (const stop of plan.stops) {
        const { id, appointmentAt, ...fields } = stop;
        if (id === arrived?.id) {
          await tx.stop.update({ where: { id }, data: { sequence: ++sequence } });
          continue;
        }
        const data = { ...fields, latitude: stop.latitude, longitude: stop.longitude, appointmentAt: appointmentAt ? new Date(appointmentAt) : null, sequence: ++sequence, tourId };
        await tx.stop.upsert({ where: { id }, create: { id, ...data }, update: data });
      }
      for (const leg of plan.legs) await tx.leg.create({ data: { tourId: leg.tourId, fromStopId: leg.fromStopId, toStopId: leg.toStopId, distanceMeters: Math.round(leg.route.distanceMeters), routeGeometry: JSON.stringify(leg.route.geometry), routingDurationSeconds: Math.round(leg.route.durationSeconds), simulatedDurationSeconds: leg.duration, routeDetails: JSON.stringify({ ...leg.route, ...(leg.active ? { travelledGeometry: plan.position.travelledGeometry, previousTravelledDistanceMeters: plan.position.distanceTravelledMeters } : {}) }), startedAt: leg.active ? now : null, status: leg.active ? 'ACTIVE' : 'WAITING' } });
      if (!arrived) await rebaseActiveLeg(tx, context.vehicle.id, clock, now);
      else await tx.vehicle.update({ where: { id: context.vehicle.id }, data: { operationVersion: { increment: 1 } } });
      await tx.routePreview.update({ where: { id: preview.id }, data: { appliedAt: now } });
      await tx.operationEvent.create({ data: { vehicleId: context.vehicle.id, tourId, type: 'ROUTE_REPLANNED', payloadJson: JSON.stringify({ previewId: preview.id, affectedTourIds: plan.affectedTourIds, origin: plan.origin }) } });
      return tx.tour.findUniqueOrThrow({ where: { id: tourId }, include });
    });
  }
}
export { ReplanningService as RouteReplanningService };
