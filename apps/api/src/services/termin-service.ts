import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Coordinate, CurrentPosition } from '../domain.js';
import { AssistantError } from './dispatcher-assistant.js';
import { dailyRestOf } from './rest-at-stop.js';
import { RoutingError, type RoutingProvider } from './routing.js';
import { calculateSimulatedDuration, parseGeometry } from './simulation.js';
import { driverBudgetFromWebfleet, planTermin, type DriverBudget, type PlannerStop, type TerminPlan } from './termin-planner.js';
import { withTerminGroups } from './termin-groups.js';
import { breakdownTiming, snapshotVehicleClock } from './tours.js';
import type { TruckRouteProfile } from './traffic-routing.js';
import type { DriverHours } from './webfleet-live.js';
import { ZULADUNG_WARNING, zuladungState } from './zuladung.js';

/** Live routing requests per plan: the active tour drives on its stored legs, only stops without a leg are routed. */
const MAX_ROUTING_CALLS = 4;

export const terminInputSchema = z.object({
  stopId: z.string().trim().min(1).max(200).optional(),
  address: z.string().trim().min(1).max(1000).optional(),
  type: z.enum(['LOAD', 'UNLOAD', 'VISIT']).optional(),
  appointmentAt: z.string().datetime({ offset: true }).optional()
}).strict().refine(value => !(value.stopId && value.address), { message: 'Укажите либо точку тура, либо новый адрес.' });
export type TerminInput = z.input<typeof terminInputSchema>;

type VehicleWithTours = Prisma.VehicleGetPayload<{ include: { issues: true; tours: { include: { stops: true; legs: true } } } }>;
type StopRow = VehicleWithTours['tours'][number]['stops'][number];
export type DriverHoursReader = (vehicleId: string, now: Date) => Promise<DriverHours>;

export function stopLabel(stop: { type: string; company?: string | null; city?: string | null; address: string }): string {
  const word = stop.type === 'LOAD' ? 'Загрузка' : stop.type === 'UNLOAD' ? 'Выгрузка' : 'Точка';
  const place = [stop.company, stop.city ?? stop.address].filter(Boolean).join(', ');
  return `${word} · ${place || stop.address}`;
}

/** Forecast only: reads the tour, the position, the tachograph and (sparingly) the router; writes nothing. */
export class TerminService {
  constructor(private readonly db: PrismaClient, private readonly routing: RoutingProvider,
    private readonly getPosition: (id: string, now: Date) => Promise<CurrentPosition>,
    private readonly driverHours: DriverHoursReader) {}

  async plan(raw: unknown, vehicleId: string, now = new Date()): Promise<TerminPlan> {
    const input = terminInputSchema.parse(raw);
    const vehicle = await this.db.vehicle.findUnique({ where: { id: vehicleId }, include: {
      issues: { where: { resolvedAt: null } },
      tours: { where: { status: { in: ['ACTIVE', 'QUEUED'] } }, orderBy: [{ queueIndex: 'asc' }, { createdAt: 'asc' }], include: { stops: { orderBy: { sequence: 'asc' } }, legs: true } }
    } });
    if (!vehicle) throw new AssistantError('Машина не найдена.', 404);
    const tours = [...vehicle.tours].sort((a, b) => Number(a.status !== 'ACTIVE') - Number(b.status !== 'ACTIVE'));
    const position = await this.getPosition(vehicle.id, now);
    const active = tours.find(t => t.status === 'ACTIVE');
    const currentStop = active?.stops.find(s => !s.completedAt);
    const activeLeg = active?.legs.find(l => ['ACTIVE', 'ARRIVED'].includes(l.status) && l.toStopId === currentStop?.id && !currentStop?.arrivedAt) ?? null;
    const snapshot = snapshotVehicleClock(vehicle, activeLeg, now);
    const warnings = new Set<string>();
    const notes = new Set<string>();
    let preliminary = false;

    const hours = await this.driverHours(vehicle.id, now);
    const driver = driverBudget(hours, now, warnings);
    const resting = dailyRestOf({ workState: hours.workState, activitySince: hours.activitySince, times: hours.times, now });
    let startAt = now;
    if (resting?.until && Date.parse(resting.until) > now.getTime()) {
      startAt = new Date(resting.until);
      notes.add(`Водитель на суточном отдыхе по тахографу; движение считается с ${startAt.toISOString()} (конец отдыха).`);
    }
    const breakdown = breakdownTiming(vehicle, now);
    if (breakdown.blocked) {
      preliminary = true;
      warnings.add(breakdown.resumeAt ? 'Есть незакрытая поломка: расчёт от ожидаемого окончания ремонта.' : 'Есть незакрытая поломка без срока ремонта: время прибытия не определено.');
      if (breakdown.resumeAt && breakdown.resumeAt > startAt) startAt = breakdown.resumeAt;
    }
    if (vehicle.manualStoppedAt) { preliminary = true; warnings.add('Машина остановлена диспетчером. Расчёт условный: движение не возобновлено.'); }
    if (!position.position) warnings.add('Неизвестна позиция машины: время до первой точки не определено.');
    else if (position.telemetryStale) { preliminary = true; warnings.add('Позиция машины по Webfleet устарела.'); }

    const truck: TruckRouteProfile = { maxSpeedKmh: vehicle.maxSpeedKmh };
    if (vehicle.truckProfile) { try { Object.assign(truck, JSON.parse(vehicle.truckProfile)); } catch { warnings.add('Параметры грузовика недоступны.'); } }
    let routingCalls = 0;
    const providers = new Set<string>();
    const geometry: Array<[number, number]> = [];
    const route = async (from: Coordinate | null, to: Coordinate, label: string, departure: Date): Promise<number | null> => {
      if (!from) return null;
      if (routingCalls >= MAX_ROUTING_CALLS) { warnings.add(`Маршрут до «${label}» не рассчитан: лимит запросов маршрутизации на один расчёт.`); return null; }
      routingCalls += 1;
      try {
        const result = await this.routing.calculateRoute(from, to, { departureTime: departure, traffic: true, source: 'manual', truck, includeInstructions: false });
        providers.add(result.provider);
        for (const point of result.geometry) geometry.push([point.longitude, point.latitude]);
        return calculateSimulatedDuration(result.distanceMeters, result.durationSeconds, vehicle.maxSpeedKmh);
      } catch (error) {
        warnings.add(error instanceof RoutingError ? `Маршрут до «${label}» не рассчитан: ${error.message}` : `Маршрут до «${label}» не рассчитан: сервис маршрутизации недоступен.`);
        return null;
      }
    };

    const built = await buildPlannerStops({ tours, activeLeg, position, driveElapsedSeconds: snapshot.driveElapsedSeconds, startAt,
      estimate: (from, to, label, departure) => route(from, to, label, departure),
      onActiveLegGeometry: (points) => { for (const point of points) geometry.push([point.longitude, point.latitude]); } });
    const stops = built.stops;
    const origin = built.origin;
    const cursor = built.cursor;
    // The second operation at a place is served under the Termin of the first: the question is about that one.
    const leadOf = new Map(tours.flatMap(tour => withTerminGroups(tour.stops).filter(s => s.terminSharedWithStopId).map(s => [s.id, s.terminSharedWithStopId!] as const)));
    let targetIndex: number;
    if (input.stopId) {
      const lead = stops.findIndex(s => s.stopId === leadOf.get(input.stopId!));
      targetIndex = lead >= 0 ? lead : stops.findIndex(s => s.stopId === input.stopId);
      if (targetIndex < 0) {
        const owned = await this.db.stop.findUnique({ where: { id: input.stopId }, include: { tour: { select: { vehicleId: true } } } });
        throw new AssistantError(owned?.tour.vehicleId === vehicleId ? 'Эта точка уже завершена: Termin для неё не нужен.' : 'Точка не принадлежит выбранной машине.', 400);
      }
    } else if (input.address) {
      const coords = await geocode(this.routing, input.address);
      const type = input.type ?? 'VISIT';
      const driveSeconds = await route(origin, coords, input.address, cursor);
      stops.push({ stopId: null, tourId: null, label: `${type === 'LOAD' ? 'Загрузка' : type === 'UNLOAD' ? 'Выгрузка' : 'Точка'} · ${input.address}`, type, driveSeconds,
        serviceMinMinutes: type === 'VISIT' ? 0 : 60, serviceMaxMinutes: type === 'VISIT' ? 0 : 120,
        appointmentAt: null, appointmentWindowStartAt: null, appointmentWindowEndAt: null, terminRequired: false, arrivedAt: null });
      targetIndex = stops.length - 1;
    } else {
      const activeCount = active ? active.stops.filter(s => !s.completedAt).length : 0;
      const follows = (s: PlannerStop) => Boolean(s.stopId && leadOf.has(s.stopId));
      targetIndex = stops.findIndex(s => s.terminRequired && !s.appointmentAt && !follows(s));
      if (targetIndex < 0) targetIndex = stops.findIndex(s => !s.appointmentAt && !s.appointmentWindowStartAt && !follows(s));
      if (targetIndex < 0 && activeCount) targetIndex = activeCount - 1;
      if (targetIndex < 0) targetIndex = stops.length - 1;
      const lead = stops.findIndex(s => Boolean(s.stopId) && s.stopId === leadOf.get(stops[targetIndex]?.stopId ?? ''));
      if (lead >= 0) targetIndex = lead;
    }
    if (!stops.length || targetIndex < 0) throw new AssistantError('Нет точек для расчёта Termin: у машины нет активного тура. Назовите адрес точки.');
    // An open Zuladung of this tour or of a tour driven before it can still delay the target: warn, never add time.
    const targetTour = tours.findIndex(t => t.id === stops[targetIndex]!.tourId);
    const upTo = targetTour >= 0 ? tours.slice(0, targetTour + 1) : tours;
    if (upTo.some(t => zuladungState(t) === 'OPEN')) warnings.add(`${ZULADUNG_WARNING} Termin может сдвинуться.`);

    return planTermin({
      now, startAt, stops, targetIndex, driver, clock: snapshot.clockState,
      vehicle: { id: vehicle.id, vehicleNumber: vehicle.vehicleNumber, licensePlate: vehicle.licensePlate },
      start: { label: resting?.until ? 'Конец суточного отдыха' : breakdown.resumeAt ? 'Ожидаемое окончание ремонта' : 'Позиция машины', address: null,
        positionSource: position.positionSource ?? null, stale: Boolean(position.telemetryStale) },
      warnings: [...warnings], notes: [...notes], preliminary,
      candidateAt: input.appointmentAt ? new Date(input.appointmentAt) : null,
      geometry, routingProviders: [...providers]
    });
  }
}

/** How long the drive to a stop without a stored leg takes; `approachSeconds` is the tour's planned approach when it has one. */
export type DriveEstimate = (from: Coordinate | null, to: Coordinate, label: string, departure: Date, approachSeconds: number | null) => Promise<number | null>;
type TourRow = VehicleWithTours['tours'][number];

/**
 * The remaining stops of the active tour and the queue, with the drive to each: the active leg from GPS or the drive timer,
 * later legs from their stored duration, and only stops without a leg through `estimate` (TomTom, or an offline guess).
 */
export async function buildPlannerStops(input: {
  tours: TourRow[]; activeLeg: TourRow['legs'][number] | null; position: CurrentPosition; driveElapsedSeconds: number; startAt: Date;
  estimate: DriveEstimate; onActiveLegGeometry?: (points: Coordinate[]) => void;
}): Promise<{ stops: PlannerStop[]; origin: Coordinate | null; cursor: Date }> {
  const { position, activeLeg } = input;
  const stops: PlannerStop[] = [];
  let origin: Coordinate | null = position.position;
  let cursor = input.startAt;
  for (const tour of input.tours) {
    const started = tour.stops.some(s => s.completedAt || s.arrivedAt);
    for (const [index, stop] of tour.stops.filter(s => !s.completedAt).entries()) {
      const leg = tour.legs.find(l => l.toStopId === stop.id && l.status !== 'COMPLETED');
      const coords: Coordinate = { latitude: stop.latitude, longitude: stop.longitude };
      let driveSeconds: number | null;
      if (stop.arrivedAt) driveSeconds = 0;
      else if (leg && leg.id === activeLeg?.id) {
        // Fresh GPS: the remaining share of the leg; otherwise what the drive timer has not yet covered.
        const gps = position.positionSource === 'WEBFLEET' && !position.telemetryStale && leg.distanceMeters > 0 ? position.remainingDistanceMeters / leg.distanceMeters : null;
        driveSeconds = Math.max(0, gps !== null ? leg.simulatedDurationSeconds * Math.min(1, gps) : leg.simulatedDurationSeconds - input.driveElapsedSeconds);
        if (leg.routeGeometry) input.onActiveLegGeometry?.(parseGeometry(leg.routeGeometry));
      } else if (leg && stops.length) driveSeconds = leg.simulatedDurationSeconds;
      else driveSeconds = await input.estimate(origin, coords, stop.city ?? stop.address, cursor, index === 0 && !started ? tour.approachDurationSeconds ?? null : null);
      stops.push(plannerStop(stop, tour.id, driveSeconds));
      if (driveSeconds !== null) cursor = new Date(cursor.getTime() + (driveSeconds + stop.serviceMinMinutes * 60) * 1000);
      origin = coords;
    }
  }
  return { stops, origin, cursor };
}

function plannerStop(stop: StopRow, tourId: string, driveSeconds: number | null): PlannerStop {
  const type = stop.type === 'LOAD' || stop.type === 'UNLOAD' ? stop.type : 'VISIT';
  return { stopId: stop.id, tourId, label: stopLabel(stop), type, driveSeconds,
    serviceMinMinutes: stop.serviceMinMinutes, serviceMaxMinutes: stop.serviceMaxMinutes,
    appointmentAt: stop.appointmentAt?.toISOString() ?? null, appointmentWindowStartAt: stop.appointmentWindowStartAt?.toISOString() ?? null,
    appointmentWindowEndAt: stop.appointmentWindowEndAt?.toISOString() ?? null, terminRequired: stop.terminRequired, arrivedAt: stop.arrivedAt?.toISOString() ?? null };
}

/** Tachograph budgets, or null with the reason the plan falls back to the calculated clock. */
export function driverBudget(hours: DriverHours, now: Date, warnings: Set<string>): DriverBudget | null {
  if (hours.status === 'NO_WEBFLEET') { warnings.add('Машина не привязана к Webfleet: часы водителя по тахографу недоступны.'); return null; }
  if (hours.status === 'NONE') { warnings.add('Карта водителя не вставлена: часы по тахографу недоступны.'); return null; }
  if (hours.status === 'WAITING' || !hours.times) { warnings.add('Данные тахографа Webfleet ещё не получены.'); return null; }
  const budget = driverBudgetFromWebfleet(hours.times, { workState: hours.workState, since: hours.activitySince }, now);
  if (!budget) warnings.add('Данные тахографа Webfleet старше часа: расчёт по расчётным часам машины.');
  return budget;
}

async function geocode(routing: RoutingProvider, address: string): Promise<Coordinate> {
  try {
    const result = await routing.geocode(address);
    return { latitude: result.latitude, longitude: result.longitude };
  } catch (error) {
    if (error instanceof RoutingError && error.statusCode < 500) throw new AssistantError(`Адрес точки не найден: «${address}». Проверьте адрес.`, 404);
    throw error;
  }
}
