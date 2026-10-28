import type { PrismaClient } from '@prisma/client';
import type { Coordinate } from '../domain.js';
import { TourService, TourPlanConflictError, snapshotVehicleClock, makePersistedDrivePlan } from './tours.js';
import { NotificationService } from './notifications.js';
import { TrafficRoutingService, type TrafficRefreshSource, type TrafficRouteResult, type RouteAlternativeProposal, type TruckRouteProfile } from './traffic-routing.js';
import { calculateSimulatedDuration, parseGeometry, splitGeometryAtProgress } from './simulation.js';

type TrafficDetails = {
  checkedAt?: string; attemptedAt?: string; providerStatus?: string; warning?: string;
  activeRoute?: TrafficRouteResult; proposals?: RouteAlternativeProposal[];
  travelledGeometry?: Coordinate[]; refreshIntervalSeconds?: number; reason?: string;
};

export function trafficRefreshInterval(remainingQuota: number, movingVehicles: number, now: Date): number {
  if (remainingQuota <= 0) return Number.POSITIVE_INFINITY;
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(600, Math.ceil((monthEnd - now.getTime()) / 1000 * movingVehicles / remainingQuota));
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
      const moving: Array<{ id: string; due: number; priority: number }> = [];
      for (const vehicle of vehicles) {
        const position = await this.getPosition(vehicle.id, now);
        if (position.status !== 'MOVING') continue;
        const { details, leg } = await this.context(vehicle.id);
        moving.push({ id: vehicle.id, due: Date.parse(details.attemptedAt ?? details.checkedAt ?? '') || 0,
          priority: Number((details.activeRoute?.trafficDelaySeconds ?? 0) >= 600) + Number(Boolean(leg?.toStop.appointmentAt && position.delayMinutes > 0)) });
      }
      const quota = await this.routing.quotaStatus('background', now);
      const interval = trafficRefreshInterval(quota?.availableForSource ?? 0, moving.length, now);
      moving.sort((a, b) => b.priority - a.priority || a.due - b.due);
      // Sequential requests keep the free-quota reserve deterministic and avoid bursts.
      for (const item of moving) {
        const context = await this.context(item.id);
        if (!context.leg) continue;
        await this.db.leg.updateMany({ where: { id: context.leg.id, updatedAt: context.leg.updatedAt }, data: { routeDetails: JSON.stringify({ ...context.details,
          refreshIntervalSeconds: Number.isFinite(interval) ? interval : null,
          reason: !Number.isFinite(interval) ? 'Бесплатная квота недоступна.' : interval > 600 ? 'Интервал увеличен из-за бесплатной квоты.' : null }) } });
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
      const refreshed = await this.routing.refreshCurrentRoute({ origin: position.position, destination: context.leg.toStop,
        supportingPoints: remaining, options: { source, includeInstructions: true, truck: truckProfile(context.vehicle.truckProfile, context.vehicle.maxSpeedKmh) } });
      const details: TrafficDetails = { ...context.details, attemptedAt: now.toISOString(),
        providerStatus: refreshed.activeRoute.providerStatus, warning: refreshed.activeRoute.warning,
        proposals: refreshed.activeRoute.providerStatus === 'live-traffic' ? refreshed.alternatives : [] };
      if (refreshed.activeRoute.providerStatus === 'live-traffic') {
        details.checkedAt = now.toISOString(); details.activeRoute = refreshed.activeRoute;
        await this.applyRoute(context, refreshed.activeRoute, details, now, 'TRAFFIC_REFRESH');
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
      checkedAt: now.toISOString(), attemptedAt: now.toISOString(), providerStatus: 'live-traffic', warning: undefined }, now, 'REROUTE_ACCEPTED');
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
    details: TrafficDetails, now: Date, eventType: string) {
    const { leg, vehicle } = context;
    if (!leg || leg.toStop.arrivedAt) throw new TourPlanConflictError('Маршрут больше не находится в движении.');
    const snapshot = snapshotVehicleClock(vehicle, leg, now);
    const prefix = splitGeometryAtProgress(parseGeometry(leg.routeGeometry), snapshot.progress).travelledGeometry;
    details.travelledGeometry = [...(context.details.travelledGeometry ?? []), ...prefix];
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

function readDetails(raw?: string | null): TrafficDetails {
  try { return raw ? JSON.parse(raw) as TrafficDetails : {}; } catch { return {}; }
}
function truckProfile(raw: string | null, maxSpeedKmh: number): TruckRouteProfile {
  try { return { ...(raw ? JSON.parse(raw) : {}), maxSpeedKmh }; } catch { return { maxSpeedKmh }; }
}
