import type { PrismaClient } from '@prisma/client';
import { writeAuditLog, type AuditActor } from './audit-log.js';
import { AGREE_METERS, placeKey, type LearnedPlace } from './stay-places.js';
import { distanceMeters } from './webfleet.js';

const ACTOR: AuditActor = { role: 'system', sessionId: 'learned-gates' };
// A point the dispatcher set through an address rule is the dispatcher's choice: the gate never overrides it.
const KEPT_PROVIDERS = new Set(['address-rule']);

export type MovedStop = { stopId: string; tourId: string; vehicleId: string; meters: number };

/**
 * Once trucks agreed on a plant's gate (owner, 18.11.2026), stops already planned at that door move there too, not only
 * the next Auftrag: arrival, ETA and the route then aim at where the trucks really load. Only stops nobody has reached yet
 * in active and queued tours are moved; each truck's route is drawn again, and a truck whose route cannot be drawn keeps
 * its points.
 */
export class LearnedGates {
  constructor(private readonly db: PrismaClient, private readonly rebuildLegs: (vehicleId: string, now: Date, actor?: AuditActor) => Promise<unknown>) {}

  async moveOpenStops(place: LearnedPlace, now = new Date()): Promise<MovedStop[]> {
    const stops = await this.db.stop.findMany({
      where: { completedAt: null, arrivedAt: null, tour: { status: { in: ['ACTIVE', 'QUEUED'] } } },
      select: { id: true, company: true, address: true, city: true, latitude: true, longitude: true, geocodeProvider: true, tourId: true,
        tour: { select: { vehicleId: true, orderNumber: true, vehicle: { select: { vehicleNumber: true } } } } }
    });
    const due = stops.filter((stop) => placeKey(stop)?.key === place.key && !KEPT_PROVIDERS.has(stop.geocodeProvider ?? '')
      && distanceMeters(stop.latitude, stop.longitude, place.latitude, place.longitude) > AGREE_METERS);
    const byVehicle = new Map<string, typeof due>();
    for (const stop of due) byVehicle.set(stop.tour.vehicleId, [...(byVehicle.get(stop.tour.vehicleId) ?? []), stop]);

    const moved: MovedStop[] = [];
    for (const [vehicleId, group] of byVehicle) {
      await this.db.$transaction(group.map((stop) => this.db.stop.update({ where: { id: stop.id },
        data: { latitude: place.latitude, longitude: place.longitude, geocodeProvider: 'gps-stay', geocodePrecision: 'EXACT' } })));
      try {
        await this.rebuildLegs(vehicleId, now, ACTOR);
      } catch (error) {
        // The route could not be drawn (the tour changed meanwhile, the router is down): the truck keeps its points.
        await this.db.$transaction(group.map((stop) => this.db.stop.update({ where: { id: stop.id },
          data: { latitude: stop.latitude, longitude: stop.longitude, geocodeProvider: stop.geocodeProvider } })));
        await writeAuditLog(this.db, ACTOR, { action: 'STOP_MOVE_TO_GATE_SKIPPED', entityType: 'KnownAddress', entityId: place.externalId, vehicleId,
          metadata: { stops: group.map((stop) => stop.id), reason: error instanceof Error ? error.message.slice(0, 200) : 'Маршрут не пересчитан.' }, createdAt: now });
        continue;
      }
      for (const stop of group) {
        const meters = Math.round(distanceMeters(stop.latitude, stop.longitude, place.latitude, place.longitude));
        await writeAuditLog(this.db, ACTOR, { action: 'STOP_MOVED_TO_LEARNED_GATE', entityType: 'Stop', entityId: stop.id, vehicleId, tourId: stop.tourId, stopId: stop.id,
          metadata: { from: { latitude: stop.latitude, longitude: stop.longitude }, to: { latitude: place.latitude, longitude: place.longitude }, meters, place: place.externalId }, createdAt: now });
        moved.push({ stopId: stop.id, tourId: stop.tourId, vehicleId, meters });
      }
      const first = group[0];
      const where = first.company || first.city || first.address;
      const far = Math.max(...group.map((stop) => distanceMeters(stop.latitude, stop.longitude, place.latitude, place.longitude)));
      const dedupKey = `gate-moved:${place.externalId}:${vehicleId}`;
      const message = `LKW ${first.tour.vehicle.vehicleNumber}, точка ${where} в туре ${first.tour.orderNumber} перенесена на ворота, где машины стояли при прошлых визитах (${far >= 1000 ? `${(Math.round(far / 100) / 10).toLocaleString('de-DE')} км` : `${Math.round(far / 10) * 10} м`} от адреса). Маршрут и ETA пересчитаны.`;
      await this.db.notification.upsert({ where: { dedupKey },
        create: { dedupKey, vehicleId, stopId: first.id, type: 'STOP_MOVED_TO_GATE', message, payloadJson: JSON.stringify({ stops: group.map((stop) => stop.id), place: place.externalId }) },
        update: { message, acknowledgedAt: null } });
    }
    return moved;
  }
}
