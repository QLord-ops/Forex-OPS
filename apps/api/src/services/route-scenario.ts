import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Coordinate, CurrentPosition } from '../domain.js';
import type { RoutingProvider } from './routing.js';
import type { TrafficRouteResult, TruckRouteProfile } from './traffic-routing.js';
import { snapshotVehicleClock } from './tours.js';
import { applyStopTime, forecastDrive, type ClockState, type VehicleClockSegment } from './vehicle-clock.js';
import { calculateSimulatedDuration } from './simulation.js';

const date = z.string().datetime({ offset: true });
export const routeScenarioInputSchema = z.object({
  vehicleId: z.string().min(1).optional(),
  originAddress: z.string().trim().min(1).max(1000).optional(),
  startMode: z.enum(['AFTER_CURRENT_TOUR', 'NOW', 'AFTER_QUEUE']).default('NOW'),
  startAt: date.optional(),
  stops: z.array(z.object({
    address: z.string().trim().min(1).max(1000), type: z.enum(['LOAD', 'UNLOAD', 'VISIT']).default('VISIT'),
    coords: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
    appointmentAt: date.nullish(), appointmentWindowStartAt: date.nullish(), appointmentWindowEndAt: date.nullish(),
    serviceMinMinutes: z.number().int().min(0).max(1440).optional(),
    serviceMaxMinutes: z.number().int().min(0).max(1440).optional()
  }).superRefine((stop, ctx) => {
    const minimum = stop.serviceMinMinutes ?? (stop.type === 'VISIT' ? 0 : 60);
    const maximum = stop.serviceMaxMinutes ?? (stop.type === 'VISIT' ? 0 : 120);
    if (maximum < minimum) ctx.addIssue({ code: 'custom', message: 'Максимальная стоянка меньше минимальной.' });
    if (stop.appointmentWindowStartAt && stop.appointmentWindowEndAt && new Date(stop.appointmentWindowStartAt) > new Date(stop.appointmentWindowEndAt)) {
      ctx.addIssue({ code: 'custom', message: 'Начало окна термина позже окончания.' });
    }
  })).min(1).max(20)
}).refine(input => Boolean(input.vehicleId || input.originAddress), { message: 'Укажите машину или начальный адрес.' });
export type RouteScenarioInput = z.input<typeof routeScenarioInputSchema>;
type Risk = 'ON_TIME' | 'RISK' | 'LATE' | 'UNKNOWN';
type Cursor = { at: Date; clock: ClockState };
type PlannedStop = {
  address: string; type: string; coords: Coordinate; appointmentAt?: Date | null;
  appointmentWindowStartAt?: Date | null; appointmentWindowEndAt?: Date | null;
  serviceMinMinutes: number; serviceMaxMinutes: number; arrivedAt?: Date | null;
};
export type ScenarioStopResult = {
  address: string; type: string; coords: Coordinate;
  earliestArrival: string | null; latestArrival: string | null;
  earliestServiceStart: string | null; latestServiceStart: string | null;
  waitingMinutes: { earliest: number | null; latest: number | null };
  earliestDeparture: string | null; latestDeparture: string | null;
  serviceMinMinutes: number; serviceMaxMinutes: number;
  risk: Risk; segments: { earliest: VehicleClockSegment[]; latest: VehicleClockSegment[] };
};

/** Forecast only. The only allowed writes are those inside the shared routing quota store. */
export class RouteScenarioService {
  constructor(private readonly db: PrismaClient, private readonly routing: RoutingProvider,
    private readonly getPosition: (id: string, now: Date) => Promise<CurrentPosition>) {}

  async calculate(raw: RouteScenarioInput, now = new Date()) {
    const input = routeScenarioInputSchema.parse(raw);
    if (input.originAddress) return this.calculateFree(input, now);
    const vehicle = await this.db.vehicle.findUniqueOrThrow({ where: { id: input.vehicleId }, include: {
      issues: { where: { kind: 'BREAKDOWN', resolvedAt: null } },
      tours: { where: { status: { in: ['ACTIVE', 'QUEUED'] } }, orderBy: [{ queueIndex: 'asc' }, { createdAt: 'asc' }],
        include: { stops: { orderBy: { sequence: 'asc' } }, legs: true } }
    } });
    const position = await this.getPosition(vehicle.id, now);
    const tours = [...vehicle.tours].sort((a, b) => Number(a.status !== 'ACTIVE') - Number(b.status !== 'ACTIVE'));
    const currentStop = tours.find(t => t.status === 'ACTIVE')?.stops.find(s => !s.completedAt);
    const activeLeg = tours.flatMap(t => t.legs).find(l => ['ACTIVE', 'ARRIVED'].includes(l.status) && l.toStopId === currentStop?.id && !currentStop.arrivedAt);
    const snapshot = snapshotVehicleClock(vehicle, activeLeg ?? null, now);
    const warnings = new Set<string>();
    let preliminary = snapshot.clockState.kind !== 'KNOWN' || !position.position;
    if (snapshot.clockState.kind !== 'KNOWN') warnings.add('Не заполнены исходные часы машины. Прогноз предварительный.');
    if (!position.position) warnings.add('Неизвестна начальная позиция машины. Время прибытия не определено.');
    if (position.telemetryStale) { preliminary = true; warnings.add('Позиция машины устарела.'); }
    if (vehicle.manualStoppedAt) { preliminary = true; warnings.add('Машина остановлена. Расчёт условный и не возобновляет движение.'); }
    const breakdowns = vehicle.issues;
    let availableAt = now;
    if (breakdowns.length) {
      preliminary = true;
      warnings.add('Есть незакрытая поломка. Прогноз зависит от окончания ремонта.');
      for (const issue of breakdowns) if (issue.expectedResolvedAt && issue.expectedResolvedAt > availableAt) availableAt = issue.expectedResolvedAt;
    }
    const truck: TruckRouteProfile = { maxSpeedKmh: vehicle.maxSpeedKmh };
    if (vehicle.truckProfile) { try { Object.assign(truck, JSON.parse(vehicle.truckProfile)); } catch { warnings.add('Параметры грузовика недоступны.'); } }
    let early: Cursor = { at: availableAt, clock: snapshot.clockState };
    early = wait(early, availableAt);
    let late = structuredClone(early);
    let origin = position.position;
    const geometry: Coordinate[] = [];
    let distanceMeters = 0;
    let hadMissingRoute = !origin || breakdowns.some(issue => !issue.expectedResolvedAt);
    if (breakdowns.some(issue => !issue.expectedResolvedAt)) warnings.add('Неизвестно время окончания ремонта: ETA точек не определена.');
    const prefix = input.startMode === 'NOW' ? [] : input.startMode === 'AFTER_QUEUE' ? tours : tours.filter(t => t.status === 'ACTIVE');
    const downstream = tours.filter(t => !prefix.includes(t));
    const sources = new Set<string>();
    let requiresDailyRest = false;

    const advance = async (stop: PlannedStop, options: { seconds?: number; showGeometry?: boolean } = {}): Promise<ScenarioStopResult> => {
      let seconds = options.seconds;
      let earlySegments: VehicleClockSegment[] = [], lateSegments: VehicleClockSegment[] = [];
      if (!stop.arrivedAt) {
        if (seconds === undefined && origin) {
          const route = await this.routing.calculateRoute(origin, stop.coords, { departureTime: early.at, traffic: true, source: 'manual', truck, includeInstructions: true });
          seconds = calculateSimulatedDuration(route.distanceMeters, route.durationSeconds, vehicle.maxSpeedKmh);
          sources.add(route.provider);
          if ((route as Partial<TrafficRouteResult>).providerStatus !== 'live-traffic') warnings.add('Без актуальных пробок и проверки грузовых ограничений на части маршрута.');
          if (options.showGeometry) { geometry.push(...route.geometry); distanceMeters += route.distanceMeters; }
        }
        if (seconds === undefined) hadMissingRoute = true;
        else {
          const a = forecastDrive(early.clock, seconds, early.at), b = forecastDrive(late.clock, seconds, late.at);
          early = { at: new Date(a.endAt), clock: a.state }; late = { at: new Date(b.endAt), clock: b.state };
          earlySegments = a.segments; lateSegments = b.segments;
          requiresDailyRest ||= [...a.segments, ...b.segments].some(segment => segment.type === 'DAILY_REST');
          [...a.warnings, ...b.warnings].forEach(w => warnings.add(w));
        }
      }
      const arrivalEarly = stop.arrivedAt ?? early.at, arrivalLate = stop.arrivedAt ?? late.at;
      const serviceStart = stop.appointmentAt ?? stop.appointmentWindowStartAt;
      const deadline = stop.appointmentAt ?? stop.appointmentWindowEndAt;
      const serviceEarly = new Date(Math.max(arrivalEarly.getTime(), serviceStart?.getTime() ?? 0));
      const serviceLate = new Date(Math.max(arrivalLate.getTime(), serviceStart?.getTime() ?? 0));
      const earlyEnd = Math.max(early.at.getTime(), Math.max(arrivalEarly.getTime(), serviceStart?.getTime() ?? 0) + stop.serviceMinMinutes * 60000);
      const lateEnd = Math.max(late.at.getTime(), Math.max(arrivalLate.getTime(), serviceStart?.getTime() ?? 0) + stop.serviceMaxMinutes * 60000);
      early = wait(early, new Date(earlyEnd)); late = wait(late, new Date(lateEnd));
      origin = stop.coords;
      return { address: stop.address, type: stop.type, coords: stop.coords,
        earliestArrival: hadMissingRoute ? null : arrivalEarly.toISOString(), latestArrival: hadMissingRoute ? null : arrivalLate.toISOString(),
        earliestServiceStart: hadMissingRoute ? null : serviceEarly.toISOString(), latestServiceStart: hadMissingRoute ? null : serviceLate.toISOString(),
        waitingMinutes: { earliest: hadMissingRoute ? null : Math.round((serviceEarly.getTime() - arrivalEarly.getTime()) / 60000),
          latest: hadMissingRoute ? null : Math.round((serviceLate.getTime() - arrivalLate.getTime()) / 60000) },
        earliestDeparture: hadMissingRoute ? null : early.at.toISOString(), latestDeparture: hadMissingRoute ? null : late.at.toISOString(),
        serviceMinMinutes: stop.serviceMinMinutes, serviceMaxMinutes: stop.serviceMaxMinutes,
        risk: preliminary || hadMissingRoute ? 'UNKNOWN' : deadline ? classify(arrivalEarly, arrivalLate, deadline) : 'ON_TIME',
        segments: { earliest: earlySegments, latest: lateSegments } };
    };
    for (const tour of prefix) {
      if (tour.plannedStartAt && tour.status !== 'ACTIVE') { early = wait(early, tour.plannedStartAt); late = wait(late, tour.plannedStartAt); }
      for (const stop of tour.stops.filter(s => !s.completedAt)) {
      const leg = tour.legs.find(l => l.toStopId === stop.id && l.status !== 'COMPLETED');
      const seconds = leg ? Math.max(0, leg.simulatedDurationSeconds - (leg.id === activeLeg?.id ? snapshot.driveElapsedSeconds : 0)) : undefined;
      if (leg) warnings.add('Оставшийся текущий маршрут рассчитан по сохранённым данным; трафик на нём может устареть.');
      await advance({ ...stop, coords: { latitude: stop.latitude, longitude: stop.longitude } }, { seconds });
      }
    }
    if (input.startAt) {
      const requested = new Date(input.startAt);
      if (requested < now) warnings.add('Время старта в прошлом заменено ближайшим доступным временем.');
      early = wait(early, requested); late = wait(late, requested);
    }
    const startRange = { earliest: early.at.toISOString(), latest: late.at.toISOString() };
    const baselineEarly = structuredClone(early), baselineLate = structuredClone(late), baselineOrigin = origin;
    const stops: ScenarioStopResult[] = [];
    for (const stop of input.stops) {
      const coords = stop.coords ?? await this.routing.geocode(stop.address);
      stops.push(await advance({ ...stop, coords,
        appointmentAt: stop.appointmentAt ? new Date(stop.appointmentAt) : null,
        appointmentWindowStartAt: stop.appointmentWindowStartAt ? new Date(stop.appointmentWindowStartAt) : null,
        appointmentWindowEndAt: stop.appointmentWindowEndAt ? new Date(stop.appointmentWindowEndAt) : null,
        serviceMinMinutes: stop.serviceMinMinutes ?? (stop.type === 'VISIT' ? 0 : 60),
        serviceMaxMinutes: stop.serviceMaxMinutes ?? (stop.type === 'VISIT' ? 0 : 120)
      }, { showGeometry: true }));
    }
    preliminary ||= hadMissingRoute;
    const completion = { earliest: hadMissingRoute ? null : early.at.toISOString(), latest: hadMissingRoute ? null : late.at.toISOString() };
    const dayEnd = berlinDayEnd(now);
    const dailyRisk = classify(early.at, late.at, dayEnd);
    const finishToday: Risk = preliminary ? 'UNKNOWN' : stops.some(s => s.risk === 'LATE') || dailyRisk === 'LATE' ? 'LATE'
      : stops.some(s => s.risk === 'RISK') || dailyRisk === 'RISK' ? 'RISK' : 'ON_TIME';
    // Compare the actual downstream journey from both endpoints, not just the draft's duration.
    const draftRequiresDailyRest = requiresDailyRest;
    const projectQueue = async () => {
      const rows: Array<{ tourId: string; stopId: string; earliestArrival: string | null; latestArrival: string | null; risk: Risk }> = [];
      for (const tour of downstream) {
        if (tour.plannedStartAt && tour.status !== 'ACTIVE') { early = wait(early, tour.plannedStartAt); late = wait(late, tour.plannedStartAt); }
        for (const stop of tour.stops.filter(s => !s.completedAt)) {
        const row = await advance({ ...stop, arrivedAt: null, coords: { latitude: stop.latitude, longitude: stop.longitude } });
        rows.push({ tourId: tour.id, stopId: stop.id, earliestArrival: row.earliestArrival, latestArrival: row.latestArrival, risk: row.risk });
        }
      }
      return rows;
    };
    const changed = await projectQueue();
    early = baselineEarly; late = baselineLate; origin = baselineOrigin;
    const baseline = await projectQueue();
    return { vehicleId: vehicle.id, vehicleNumber: vehicle.vehicleNumber, operationVersion: vehicle.operationVersion,
      tourVersions: tours.map(t => ({ id: t.id, version: t.planVersion })), startMode: input.startMode,
      generatedAt: now.toISOString(), startRange, completion, dayEndsAt: dayEnd.toISOString(), finishToday,
      preliminary, stops, geometry: geometry.map(point => [point.longitude, point.latitude] as [number, number]), distanceMeters, warnings: [...warnings], routingProviders: [...sources],
      requiresDailyRest: draftRequiresDailyRest,
      downstreamQueueImpact: changed.map((row, index) => ({ ...row, previousEarliestArrival: baseline[index]?.earliestArrival ?? null,
        previousLatestArrival: baseline[index]?.latestArrival ?? null,
        delayMinutes: row.latestArrival && baseline[index]?.latestArrival ? Math.round((Date.parse(row.latestArrival) - Date.parse(baseline[index].latestArrival!)) / 60000) : null })) };
  }

  /** Explicit A → B preview ignores the selected vehicle, its hours and its operational queue. */
  private async calculateFree(input: z.output<typeof routeScenarioInputSchema>, now: Date) {
    let origin: Coordinate = await this.routing.geocode(input.originAddress!);
    let early = new Date(Math.max(now.getTime(), input.startAt ? Date.parse(input.startAt) : 0));
    let late = new Date(early);
    const startRange = { earliest: early.toISOString(), latest: late.toISOString() };
    const geometry: [number, number][] = [];
    const stops: ScenarioStopResult[] = [];
    const warnings = new Set(['Свободный маршрут: часы, паузы и ограничения конкретной машины не учитываются.']);
    const sources = new Set<string>();
    let distanceMeters = 0;
    for (const stop of input.stops) {
      const coords = stop.coords ?? await this.routing.geocode(stop.address);
      const route = await this.routing.calculateRoute(origin, coords, { departureTime: early, traffic: true, source: 'manual', includeInstructions: true });
      sources.add(route.provider);
      if ((route as Partial<TrafficRouteResult>).providerStatus !== 'live-traffic') warnings.add('Без актуальных пробок и проверки грузовых ограничений на части маршрута.');
      geometry.push(...route.geometry.map(point => [point.longitude, point.latitude] as [number, number]));
      distanceMeters += route.distanceMeters;
      const arrivalEarly = new Date(early.getTime() + route.durationSeconds * 1000);
      const arrivalLate = new Date(late.getTime() + route.durationSeconds * 1000);
      const serviceAt = stop.appointmentAt ?? stop.appointmentWindowStartAt;
      const serviceEarly = new Date(Math.max(arrivalEarly.getTime(), serviceAt ? Date.parse(serviceAt) : 0));
      const serviceLate = new Date(Math.max(arrivalLate.getTime(), serviceAt ? Date.parse(serviceAt) : 0));
      const serviceMinMinutes = stop.serviceMinMinutes ?? (stop.type === 'VISIT' ? 0 : 60);
      const serviceMaxMinutes = stop.serviceMaxMinutes ?? (stop.type === 'VISIT' ? 0 : 120);
      early = new Date(serviceEarly.getTime() + serviceMinMinutes * 60000);
      late = new Date(serviceLate.getTime() + serviceMaxMinutes * 60000);
      stops.push({ address: stop.address, type: stop.type, coords,
        earliestArrival: arrivalEarly.toISOString(), latestArrival: arrivalLate.toISOString(),
        earliestServiceStart: serviceEarly.toISOString(), latestServiceStart: serviceLate.toISOString(),
        waitingMinutes: { earliest: Math.round((+serviceEarly - +arrivalEarly) / 60000), latest: Math.round((+serviceLate - +arrivalLate) / 60000) },
        earliestDeparture: early.toISOString(), latestDeparture: late.toISOString(), serviceMinMinutes, serviceMaxMinutes,
        risk: 'UNKNOWN', segments: { earliest: [], latest: [] } });
      origin = coords;
    }
    return { vehicleId: null, vehicleNumber: null, originAddress: input.originAddress, startMode: 'NOW',
      generatedAt: now.toISOString(), startRange, completion: { earliest: early.toISOString(), latest: late.toISOString() },
      dayEndsAt: berlinDayEnd(now).toISOString(), finishToday: 'UNKNOWN' as Risk, preliminary: true,
      stops, geometry, distanceMeters, warnings: [...warnings], routingProviders: [...sources],
      requiresDailyRest: false, downstreamQueueImpact: [] };
  }
}

function wait(cursor: Cursor, until: Date): Cursor {
  const at = new Date(Math.max(cursor.at.getTime(), until.getTime()));
  return { at, clock: applyStopTime(cursor.clock, Math.max(0, (at.getTime() - Date.parse(cursor.clock.updatedAt)) / 1000), cursor.clock.updatedAt).state };
}
function classify(early: Date, late: Date, deadline: Date): Risk { return early > deadline ? 'LATE' : late > deadline ? 'RISK' : 'ON_TIME'; }
export function berlinDayEnd(now: Date): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  // Search for the next local calendar date: handles 23- and 25-hour DST days.
  let low = now.getTime(), high = low + 27 * 3600000;
  const format = (stamp: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(stamp);
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (format(mid) === day) low = mid; else high = mid; }
  return new Date(high - 1);
}
