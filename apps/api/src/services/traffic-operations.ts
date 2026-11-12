import type { PrismaClient } from '@prisma/client';
import type { Coordinate } from '../domain.js';
import { TourService, TourPlanConflictError, snapshotVehicleClock, makePersistedDrivePlan } from './tours.js';
import { NotificationService } from './notifications.js';
import { TrafficRoutingService, type TrafficRefreshSource, type TrafficRouteResult, type RouteAlternativeProposal, type TruckRouteProfile } from './traffic-routing.js';
import { calculateSimulatedDuration, parseGeometry, splitGeometryAtProgress } from './simulation.js';
import { cleanTravelled } from './travelled-path.js';
import { OFF_ROUTE_METERS } from './route-projection.js';
import { writeAuditLog, type AuditActor } from './audit-log.js';

/** What the dispatcher is told after the route was rebuilt from the truck's GPS position. */
export type AutoReroute = { distanceMeters: number; eta: string | null; previousEta: string | null; mainRoads: string[]; live: boolean };
// A driver wandering through a town must not spend the routing quota: one automatic rebuild per leg in ten minutes.
const AUTO_REROUTE_INTERVAL_MS = 600_000;
const AUTO_REROUTE_ACTOR: AuditActor = { role: 'system', sessionId: 'route-deviation' };

type StoredRouteOption = { id: string; route: TrafficRouteResult };
type TrafficDetails = {
  routeOptions?: { createdAt: string; options: StoredRouteOption[] };
  checkedAt?: string; attemptedAt?: string; providerStatus?: string; warning?: string;
  activeRoute?: TrafficRouteResult; proposals?: RouteAlternativeProposal[];
  travelledGeometry?: Coordinate[]; travelledStitches?: number[]; refreshIntervalSeconds?: number; reason?: string;
  autoReroutedAt?: string;
};

const NORMAL_MIN_SECONDS = 600;
const IMPORTANT_MIN_SECONDS = 300;

/**
 * Seconds between background traffic checks. An important truck (stuck in a jam of 10+ min or late for its Termin) is
 * checked twice as often as the rest — every 5 min (owner, 12.11.2026); both stretch together when the free monthly
 * quota would not last until the month ends.
 */
export function trafficRefreshInterval(remainingQuota: number, normalVehicles: number, now: Date, importantVehicles = 0): { normal: number; important: number } {
  if (remainingQuota <= 0) return { normal: Number.POSITIVE_INFINITY, important: Number.POSITIVE_INFINITY };
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const weight = normalVehicles + importantVehicles * (NORMAL_MIN_SECONDS / IMPORTANT_MIN_SECONDS);
  const normal = Math.max(NORMAL_MIN_SECONDS, Math.ceil((monthEnd - now.getTime()) / 1000 * weight / remainingQuota));
  return { normal, important: Math.max(IMPORTANT_MIN_SECONDS, Math.ceil(normal * IMPORTANT_MIN_SECONDS / NORMAL_MIN_SECONDS)) };
}

export class TrafficOperationsService {
  private ticking = false;
  private inFlight = new Set<string>();
  constructor(private readonly db: PrismaClient, private readonly tours: TourService,
    private readonly notifications: NotificationService, private readonly routing: TrafficRoutingService,
    private readonly getPosition = (vehicleId: string, now: Date) => tours.getCurrentPosition(vehicleId, now)) {}

  private async context(vehicleId: string) {
    const vehicle = await this.db.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    const leg = await this.db.leg.findFirst({ where: { tour: { vehicleId, status: 'ACTIVE' }, status: { in: ['ACTIVE', 'ARRIVED'] } },
      include: { toStop: true, tour: true }, orderBy: { startedAt: 'desc' } });
    return { vehicle, leg, details: readDetails(leg?.routeDetails) };
  }

  async status(vehicleId: string, now = new Date()) {
    const { vehicle, leg, details } = await this.context(vehicleId);
    const checkedAt = details.checkedAt ?? details.activeRoute?.checkedAt ?? null;
    return { ...details, vehicleId, version: vehicle.operationVersion, legId: leg?.id ?? null,
      checkedAt, stale: !checkedAt || now.getTime() - Date.parse(checkedAt) > 900_000 || details.providerStatus !== 'live-traffic',
      ageSeconds: checkedAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(checkedAt)) / 1000)) : null,
      proposals: details.proposals ?? [], quota: await this.routing.quotaStatus('manual', now) };
  }

  async tick(now = new Date()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const vehicles = await this.db.vehicle.findMany({ where: { tours: { some: { status: 'ACTIVE' } }, manualStoppedAt: null } });
      const moving = [];
      for (const vehicle of vehicles) {
        const position = await this.getPosition(vehicle.id, now);
        if (position.status !== 'MOVING') continue;
        const context = await this.context(vehicle.id);
        const { details, leg } = context;
        moving.push({ id: vehicle.id, context, due: Date.parse(details.attemptedAt ?? details.checkedAt ?? '') || 0,
          priority: Number((details.activeRoute?.trafficDelaySeconds ?? 0) >= 600) + Number(Boolean(leg?.toStop.appointmentAt && position.delayMinutes > 0)) });
      }
      const quota = await this.routing.quotaStatus('background', now);
      const important = moving.filter((item) => item.priority > 0).length;
      const intervals = trafficRefreshInterval(quota?.availableForSource ?? 0, moving.length - important, now, important);
      moving.sort((a, b) => b.priority - a.priority || a.due - b.due);
      // Sequential requests keep the free-quota reserve deterministic and avoid bursts.
      for (const item of moving) {
        const { context } = item;
        if (!context.leg) continue;
        const interval = item.priority > 0 ? intervals.important : intervals.normal;
        const refreshIntervalSeconds = Number.isFinite(interval) ? interval : null;
        const reason = !Number.isFinite(interval) ? 'Бесплатная квота недоступна.' : intervals.normal > NORMAL_MIN_SECONDS ? 'Интервал увеличен из-за бесплатной квоты.' : null;
        // Write only when something changed: a rewrite every 15 s would void the dispatcher's open previews.
        if (context.details.refreshIntervalSeconds !== refreshIntervalSeconds || (context.details.reason ?? null) !== reason) {
          await this.db.leg.updateMany({ where: { id: context.leg.id, updatedAt: context.leg.updatedAt }, data: { routeDetails: JSON.stringify({ ...context.details, refreshIntervalSeconds, reason }) } });
        }
        if (now.getTime() - item.due < interval * 1000) continue;
        try { await this.refresh(item.id, 'background', now); } catch { /* Next tick retries; old traffic remains explicitly aged. */ }
      }
    } finally { this.ticking = false; }
  }

  async refresh(vehicleId: string, source: TrafficRefreshSource = 'manual', now = new Date()) {
    if (this.inFlight.has(vehicleId)) return this.status(vehicleId, now);
    this.inFlight.add(vehicleId);
    try {
      const context = await this.context(vehicleId);
      const position = await this.getPosition(vehicleId, now);
      if (!context.leg || context.leg.toStop.arrivedAt || (source === 'background' && position.status !== 'MOVING')) return this.status(vehicleId, now);
      const remaining = position.remainingGeometry.map(([longitude, latitude]) => ({ latitude, longitude }));
      if (remaining.length < 2 || !position.position) return this.status(vehicleId, now);
      // The route always starts at the truck. Off the planned line the old line would drag it back, so TomTom plans afresh.
      const offRoute = (position.offRouteMeters ?? 0) > OFF_ROUTE_METERS;
      const refreshed = await this.routing.refreshCurrentRoute({ origin: position.position, destination: context.leg.toStop,
        supportingPoints: offRoute ? undefined : [position.position, ...remaining.slice(1)], options: { source, includeInstructions: true, truck: truckProfile(context.vehicle.truckProfile, context.vehicle.maxSpeedKmh) } });
      const details: TrafficDetails = { ...context.details, attemptedAt: now.toISOString(),
        providerStatus: refreshed.activeRoute.providerStatus, warning: refreshed.activeRoute.warning,
        proposals: refreshed.activeRoute.providerStatus === 'live-traffic' ? refreshed.alternatives : [] };
      if (refreshed.activeRoute.providerStatus === 'live-traffic') {
        details.checkedAt = now.toISOString(); details.activeRoute = refreshed.activeRoute;
        await this.applyRoute(context, refreshed.activeRoute, details, now, 'TRAFFIC_REFRESH', gpsTravelled(position));
      } else {
        await this.db.leg.updateMany({ where: { id: context.leg.id, updatedAt: context.leg.updatedAt }, data: { routeDetails: JSON.stringify(details) } });
      }
      if (refreshed.activeRoute.providerStatus === 'live-traffic' && (refreshed.activeRoute.hasRoadClosure || refreshed.activeRoute.trafficDelaySeconds >= 600)) {
        await this.notifications.publish({ dedupKey: `traffic:${context.leg.id}:${Math.floor(now.getTime() / 600_000)}`, vehicleId,
          stopId: context.leg.toStopId, type: 'TRAFFIC_DELAY',
          message: `Грузовик ${context.vehicle.vehicleNumber}: ${refreshed.activeRoute.hasRoadClosure ? 'перекрытие дороги' : `задержка из-за трафика ${Math.ceil(refreshed.activeRoute.trafficDelaySeconds / 60)} мин`}`,
          payload: { checkedAt: now.toISOString(), roadNumbers: refreshed.activeRoute.roadNumbers } });
      }
      return this.status(vehicleId, now);
    } finally { this.inFlight.delete(vehicleId); }
  }

  /**
   * The driver left the planned line: the route to the next stop is planned afresh from the real GPS position and
   * becomes the tour's route. Only fresh Webfleet GPS triggers it; a route without live traffic is still better than
   * a line the truck is no longer on. Null: nothing was changed.
   */
  async rerouteFromGps(vehicleId: string, now = new Date()): Promise<AutoReroute | null> {
    if (this.inFlight.has(vehicleId)) return null;
    this.inFlight.add(vehicleId);
    try {
      const context = await this.context(vehicleId);
      const position = await this.getPosition(vehicleId, now);
      if (!context.leg || context.leg.toStop.arrivedAt || position.etaSource !== 'GPS' || !position.position) return null;
      const last = Date.parse(context.details.autoReroutedAt ?? '');
      if (last && now.getTime() - last < AUTO_REROUTE_INTERVAL_MS) return null;
      const refreshed = await this.routing.refreshCurrentRoute({ origin: position.position, destination: context.leg.toStop,
        options: { source: 'background', includeInstructions: true, truck: truckProfile(context.vehicle.truckProfile, context.vehicle.maxSpeedKmh) } });
      const route = refreshed.activeRoute;
      if (route.geometry.length < 2 || !(route.distanceMeters > 0)) return null;
      const live = route.providerStatus === 'live-traffic';
      const details: TrafficDetails = { ...context.details, routeOptions: undefined, autoReroutedAt: now.toISOString(), attemptedAt: now.toISOString(),
        providerStatus: route.providerStatus, warning: route.warning, activeRoute: route, proposals: live ? refreshed.alternatives : [],
        ...(live ? { checkedAt: now.toISOString() } : {}) };
      try {
        await this.applyRoute(context, route, details, now, 'ROUTE_REBUILT_AUTO', gpsTravelled(position));
      } catch (error) {
        // The dispatcher changed the tour in the same second: their change stands.
        if (error instanceof TourPlanConflictError) return null;
        throw error;
      }
      await writeAuditLog(this.db, AUTO_REROUTE_ACTOR, { action: 'ROUTE_REBUILT_AUTO', entityType: 'Vehicle', entityId: vehicleId, vehicleId, tourId: context.leg.tourId,
        metadata: { legId: context.leg.id, offRouteMeters: position.offRouteMeters ?? null, distanceMeters: route.distanceMeters, providerStatus: route.providerStatus } });
      const after = await this.getPosition(vehicleId, now).catch(() => null);
      return { distanceMeters: route.distanceMeters, eta: after?.eta ?? null, previousEta: position.eta ?? null,
        mainRoads: route.mainRoads ?? route.roadNumbers.slice(0, 2), live };
    } finally { this.inFlight.delete(vehicleId); }
  }

  async accept(vehicleId: string, index: number, version: number, origin?: Coordinate, now = new Date()) {
    const context = await this.context(vehicleId);
    const proposal = context.details.proposals?.[index];
    if (!context.leg || !proposal || context.vehicle.operationVersion !== version) throw new TourPlanConflictError('Предложение объезда изменилось. Обновите страницу.');
    if (!context.details.checkedAt || now.getTime() - Date.parse(context.details.checkedAt) > 600_000) {
      await this.refresh(vehicleId, 'manual', now);
      throw new TourPlanConflictError('Объезд пересчитан. Проверьте актуальное предложение.');
    }
    const position = await this.getPosition(vehicleId, now);
    if (!origin && !position.position) throw new TourPlanConflictError('Текущая позиция отсутствует.');
    // Reconstruct the selected alternative from the current/confirmed position before accepting it.
    const selected = proposal.route;
    const start = origin ?? position.position!;
    const refreshed = await this.routing.refreshCurrentRoute({ origin: start, destination: context.leg.toStop,
      supportingPoints: [start, ...selected.geometry.slice(1)],
      options: { source: 'manual', maxAlternatives: 0, truck: truckProfile(context.vehicle.truckProfile, context.vehicle.maxSpeedKmh) } });
    if (refreshed.activeRoute.providerStatus !== 'live-traffic') throw new TourPlanConflictError('Объезд нельзя подтвердить без актуальных данных о трафике.');
    await this.applyRoute(context, refreshed.activeRoute, { ...context.details, proposals: [], activeRoute: refreshed.activeRoute,
      checkedAt: now.toISOString(), attemptedAt: now.toISOString(), providerStatus: 'live-traffic', warning: undefined }, now, 'REROUTE_ACCEPTED', gpsTravelled(position));
    return this.status(vehicleId, now);
  }

  /**
   * Three routes from the truck's GPS position to its next stop. They are kept for a few minutes so the
   * dispatcher's choice is applied exactly as shown.
   */
  async routeOptions(vehicleId: string, now = new Date()) {
    const context = await this.context(vehicleId);
    const position = await this.getPosition(vehicleId, now);
    if (!context.leg || context.leg.toStop.arrivedAt) throw new TourPlanConflictError('У машины нет маршрута в движении.');
    if (position.etaSource !== 'GPS' || !position.position) throw new TourPlanConflictError('Нет свежей позиции Webfleet GPS: варианты строятся только от реальной позиции.');
    const routes = await this.routing.routeOptions(position.position, context.leg.toStop,
      { source: 'manual', truck: truckProfile(context.vehicle.truckProfile, context.vehicle.maxSpeedKmh) });
    const options = routes.map((route, index) => ({ id: `${now.getTime()}-${index}`, route }));
    await this.db.leg.updateMany({ where: { id: context.leg.id, updatedAt: context.leg.updatedAt },
      data: { routeDetails: JSON.stringify({ ...context.details, routeOptions: { createdAt: now.toISOString(), options } }) } });
    return {
      vehicleId, version: context.vehicle.operationVersion, legId: context.leg.id, checkedAt: now.toISOString(),
      offRouteMeters: position.offRouteMeters ?? null,
      current: { remainingDistanceMeters: position.remainingDistanceMeters, eta: position.eta, geometry: position.remainingGeometry },
      options: options.map(({ id, route }) => ({
        id, distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds, trafficDelaySeconds: route.trafficDelaySeconds,
        mainRoads: route.mainRoads ?? route.roadNumbers.slice(0, 2), providerStatus: route.providerStatus,
        geometry: route.geometry.map((point) => [point.longitude, point.latitude] as [number, number])
      }))
    };
  }

  /** The dispatcher picks one of the shown routes: it becomes the tour's route from the truck onwards and the ETA follows it. */
  async applyRouteOption(vehicleId: string, optionId: string, version: number, now = new Date()) {
    const context = await this.context(vehicleId);
    if (!context.leg || context.vehicle.operationVersion !== version) throw new TourPlanConflictError('Состояние машины изменилось. Постройте варианты заново.');
    const stored = context.details.routeOptions;
    const option = stored?.options.find((item) => item.id === optionId);
    if (!stored || !option || now.getTime() - Date.parse(stored.createdAt) > 600_000) throw new TourPlanConflictError('Варианты устарели. Постройте их заново.');
    const position = await this.getPosition(vehicleId, now);
    await this.applyRoute(context, option.route, { ...context.details, routeOptions: undefined, proposals: [], activeRoute: option.route,
      checkedAt: now.toISOString(), attemptedAt: now.toISOString(), providerStatus: option.route.providerStatus, warning: option.route.warning }, now, 'ROUTE_OPTION_SELECTED', gpsTravelled(position));
    return this.status(vehicleId, now);
  }

  async reject(vehicleId: string, version?: number) {
    const context = await this.context(vehicleId);
    if (version !== undefined && version !== context.vehicle.operationVersion) throw new TourPlanConflictError('Предложение устарело.');
    if (context.leg) await this.db.leg.updateMany({ where: { id: context.leg.id, updatedAt: context.leg.updatedAt },
      data: { routeDetails: JSON.stringify({ ...context.details, proposals: [] }) } });
    return this.status(vehicleId);
  }

  private async applyRoute(context: Awaited<ReturnType<TrafficOperationsService['context']>>, route: TrafficRouteResult,
    details: TrafficDetails, now: Date, eventType: string, travelled: Coordinate[] | null = null) {
    const { leg, vehicle } = context;
    if (!leg || leg.toStop.arrivedAt) throw new TourPlanConflictError('Маршрут больше не находится в движении.');
    const snapshot = snapshotVehicleClock(vehicle, leg, now);
    // With GPS the driven part is cut where the truck really is; the timer split is only for trucks without Webfleet.
    // Each stitch is remembered, so the map never joins two pieces with a straight line and drops what was not driven.
    const legGeometry = parseGeometry(leg.routeGeometry);
    const before = cleanTravelled(context.details.travelledGeometry ?? [], legGeometry[0] ?? null, context.details.travelledStitches);
    const current = travelled && travelled.length >= before.points.length ? travelled.slice(before.points.length)
      : splitGeometryAtProgress(legGeometry, snapshot.progress).travelledGeometry;
    details.travelledGeometry = [...before.points, ...current];
    details.travelledStitches = before.points.length ? [...before.starts, before.points.length] : [];
    const duration = calculateSimulatedDuration(route.distanceMeters, route.durationSeconds, vehicle.maxSpeedKmh);
    await this.db.$transaction(async tx => {
      const locked = await tx.vehicle.updateMany({ where: { id: vehicle.id, operationVersion: vehicle.operationVersion },
        data: { operationVersion: { increment: 1 }, clockState: JSON.stringify(snapshot.clockState),
          ...(vehicle.manualStoppedAt ? { manualStoppedAt: now } : {}) } });
      if (locked.count !== 1) throw new TourPlanConflictError('Состояние грузовика изменилось.');
      const changed = await tx.leg.updateMany({ where: { id: leg.id, updatedAt: leg.updatedAt, status: leg.status }, data: {
        startedAt: now, routeGeometry: JSON.stringify(route.geometry), distanceMeters: route.distanceMeters,
        routingDurationSeconds: route.durationSeconds, simulatedDurationSeconds: duration,
        drivePlan: JSON.stringify(makePersistedDrivePlan(snapshot.clockState, duration, now)), routeDetails: JSON.stringify(details)
      } });
      if (changed.count !== 1) throw new TourPlanConflictError('Маршрут был изменён.');
      await tx.routeRevision.create({ data: { tourId: leg.tourId, version: leg.tour.planVersion, snapshotJson: JSON.stringify({ leg, eventType }) } });
      await tx.tour.update({ where: { id: leg.tourId }, data: { planVersion: { increment: 1 } } });
      await tx.operationEvent.create({ data: { vehicleId: vehicle.id, tourId: leg.tourId, type: eventType,
        payloadJson: JSON.stringify({ provider: route.provider, roadNumbers: route.roadNumbers, checkedAt: route.checkedAt }) } });
    });
  }
}

function gpsTravelled(position: { etaSource?: string; travelledGeometry: Array<[number, number]> }): Coordinate[] | null {
  return position.etaSource === 'GPS' ? position.travelledGeometry.map(([longitude, latitude]) => ({ latitude, longitude })) : null;
}

function readDetails(raw?: string | null): TrafficDetails {
  try { return raw ? JSON.parse(raw) as TrafficDetails : {}; } catch { return {}; }
}
function truckProfile(raw: string | null, maxSpeedKmh: number): TruckRouteProfile {
  try { return { ...(raw ? JSON.parse(raw) : {}), maxSpeedKmh }; } catch { return { maxSpeedKmh }; }
}
