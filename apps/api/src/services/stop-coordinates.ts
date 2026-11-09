import type { PrismaClient } from '@prisma/client';
import { MAX_DISTANCE_FROM_CITY_KM, distanceKm, resolveAddressWithFallback } from './address-resolution.js';
import type { AddressRuleRecord } from './address-rules.js';
import { writeAuditLog, type AuditActor } from './audit-log.js';
import type { ReplanningService } from './replanning.js';
import type { RoutingProvider } from './routing.js';
import { calculateSimulatedDuration } from './simulation.js';

export type StopCoordinateIssue = {
  stopId: string; tourId: string; tourStatus: string; orderNumber: string; vehicleId: string; vehicleNumber: string;
  sequence: number; type: string; company: string | null; address: string; city: string | null;
  current: { latitude: number; longitude: number; resolvedAddress: string | null };
  proposed: { latitude: number; longitude: number; resolvedAddress: string; precision: string; provider: string | undefined };
  distanceKm: number; attempts: string[];
};

/**
 * Finds stops whose saved point lies far from where their address resolves today, and moves them: a stop once
 * geocoded into the wrong town (Ludwigsfelde drawn in Hamburg) sends the whole route the wrong way until it is fixed.
 * Only future stops of active and queued tours are touched; arrivals and history stay as they are.
 */
export class StopCoordinatesService {
  constructor(
    private readonly db: PrismaClient,
    private readonly routing: RoutingProvider,
    private readonly rules: () => Promise<AddressRuleRecord[]>,
    private readonly replanning: Pick<ReplanningService, 'preview' | 'apply'>
  ) {}

  async check(now = new Date(), stopIds?: string[]): Promise<StopCoordinateIssue[]> {
    const tours = await this.db.tour.findMany({
      where: { status: { in: ['ACTIVE', 'QUEUED'] } },
      include: { stops: { orderBy: { sequence: 'asc' } }, vehicle: { select: { id: true, vehicleNumber: true } } },
      orderBy: [{ vehicleId: 'asc' }, { queueIndex: 'asc' }, { createdAt: 'asc' }]
    });
    const rules = await this.rules();
    const issues: StopCoordinateIssue[] = [];
    for (const tour of tours) {
      for (const stop of tour.stops) {
        if (stop.completedAt || stop.arrivedAt || (stopIds && !stopIds.includes(stop.id))) continue;
        let resolved: Awaited<ReturnType<typeof resolveAddressWithFallback>>;
        try {
          resolved = await resolveAddressWithFallback(this.routing, { address: stop.address, city: stop.city, company: stop.company }, undefined, rules);
        } catch {
          // An address nobody can find today is left as it is: the dispatcher sees it on the map.
          continue;
        }
        const km = distanceKm(stop, resolved);
        if (km <= MAX_DISTANCE_FROM_CITY_KM) continue;
        issues.push({
          stopId: stop.id, tourId: tour.id, tourStatus: tour.status, orderNumber: tour.orderNumber, vehicleId: tour.vehicle.id, vehicleNumber: tour.vehicle.vehicleNumber,
          sequence: stop.sequence, type: stop.type, company: stop.company, address: stop.address, city: stop.city,
          current: { latitude: stop.latitude, longitude: stop.longitude, resolvedAddress: stop.resolvedAddress },
          proposed: { latitude: resolved.latitude, longitude: resolved.longitude, resolvedAddress: resolved.resolvedAddress, precision: resolved.precision, provider: resolved.provider },
          distanceKm: Math.round(km), attempts: resolved.attempts
        });
      }
    }
    return issues;
  }

  /** Moves the chosen stops to their resolved points and draws the legs of each affected truck again. */
  async fix(stopIds: string[], actor?: AuditActor, now = new Date()): Promise<{ fixed: StopCoordinateIssue[]; skipped: Array<{ vehicleNumber: string; stopIds: string[]; reason: string }> }> {
    const issues = await this.check(now, stopIds);
    const byVehicle = new Map<string, StopCoordinateIssue[]>();
    for (const issue of issues) byVehicle.set(issue.vehicleId, [...(byVehicle.get(issue.vehicleId) ?? []), issue]);
    const fixed: StopCoordinateIssue[] = [];
    const skipped: Array<{ vehicleNumber: string; stopIds: string[]; reason: string }> = [];
    for (const [vehicleId, group] of byVehicle) {
      try {
        await this.db.$transaction(async (tx) => {
          for (const issue of group) {
            await tx.stop.update({ where: { id: issue.stopId }, data: {
              latitude: issue.proposed.latitude, longitude: issue.proposed.longitude, resolvedAddress: issue.proposed.resolvedAddress,
              geocodePrecision: issue.proposed.precision, geocodeProvider: issue.proposed.provider ?? null
            } });
            await writeAuditLog(tx, actor, { action: 'STOP_COORDINATES_FIXED', entityType: 'Stop', entityId: issue.stopId, vehicleId, tourId: issue.tourId,
              metadata: { from: issue.current, to: issue.proposed, distanceKm: issue.distanceKm, address: issue.address, city: issue.city }, createdAt: now });
          }
        });
        await this.rebuildLegs(vehicleId, now, actor);
        fixed.push(...group);
      } catch (error) {
        skipped.push({ vehicleNumber: group[0].vehicleNumber, stopIds: group.map((issue) => issue.stopId), reason: error instanceof Error ? error.message : 'Маршрут не пересчитан.' });
      }
    }
    return { fixed, skipped };
  }

  private async rebuildLegs(vehicleId: string, now: Date, actor?: AuditActor) {
    const tours = await this.db.tour.findMany({
      where: { vehicleId, status: { in: ['ACTIVE', 'QUEUED'] } },
      include: { stops: { orderBy: { sequence: 'asc' } }, legs: { include: { fromStop: true, toStop: true } } },
      orderBy: [{ queueIndex: 'asc' }, { createdAt: 'asc' }]
    });
    const active = tours.find((tour) => tour.status === 'ACTIVE');
    if (active) {
      // The replan draws the active leg from the truck's position and every queued tour behind it.
      const futureStops = active.stops.filter((stop) => !stop.completedAt).map((stop) => ({
        id: stop.id, type: stop.type as 'LOAD' | 'UNLOAD', address: stop.address, company: stop.company, city: stop.city, instructions: stop.instructions,
        appointmentAt: stop.appointmentAt?.toISOString() ?? null, serviceMinMinutes: stop.serviceMinMinutes, serviceMaxMinutes: stop.serviceMaxMinutes,
        latitude: stop.latitude, longitude: stop.longitude
      }));
      const preview = await this.replanning.preview(active.id, { version: active.planVersion, futureStops }, now);
      await this.replanning.apply(active.id, { previewId: preview.id, version: active.planVersion }, now, actor);
      return;
    }
    // Only queued tours: their legs are still waiting and are simply drawn again between the saved points.
    const vehicle = await this.db.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    for (const tour of tours) {
      for (const leg of tour.legs) {
        if (leg.status !== 'WAITING') continue;
        const route = await this.routing.calculateRoute(leg.fromStop, leg.toStop);
        await this.db.leg.update({ where: { id: leg.id }, data: {
          distanceMeters: Math.round(route.distanceMeters), routeGeometry: JSON.stringify(route.geometry), routingDurationSeconds: Math.round(route.durationSeconds),
          simulatedDurationSeconds: calculateSimulatedDuration(route.distanceMeters, route.durationSeconds, vehicle.maxSpeedKmh), routeDetails: JSON.stringify(route)
        } });
      }
    }
  }
}
