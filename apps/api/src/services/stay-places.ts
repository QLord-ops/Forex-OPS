import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { addressSearchText } from './address-book.js';
import { writeAuditLog } from './audit-log.js';
import { streetKey } from './known-places.js';
import { distanceMeters, PLANT_GATE_MAX_METERS } from './webfleet.js';

/**
 * Where the trucks really stand at a place (owner, 15.11.2026: addresses that are right after reading an Auftrag). After
 * BELADEN/ENTLADEN the truck's own GPS while it stood at the stop says where the gate is, which the postal address often
 * does not (VW Baunatal: 1.2 km). The next Auftrag to the same door takes that point without asking the geocoder.
 */
export const STAY_SOURCE = 'GPS_STAY';
// One stay could be a parking place nearby; the place counts once a second stay agrees with it.
export const STAYS_TO_TRUST = 2;
export const AGREE_METERS = 300;
// Enough standing to be the loading or unloading, not a stop at the traffic light.
const MIN_STANDING_POINTS = 10;
const MIN_STANDING_SECONDS = 15 * 60;
// Closer than this to the stop's point there is nothing to correct.
const ALREADY_THERE_METERS = 100;
const STOPPED_SPEED_KMH = 5;
// Learning again within this time of the last stay at the place is the same visit (another stop of the same tour, another truck in the same queue).
const SAME_VISIT_MS = 2 * 3600_000;

type Row = { latitude: number; longitude: number; speedKmh: number | null; recordedAt: Date; rawJson: string | null };

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const standing = (row: Row) => {
  try {
    const payload = row.rawJson ? JSON.parse(row.rawJson) as { standstill?: unknown } : null;
    if (typeof payload?.standstill === 'boolean') return payload.standstill;
  } catch { /* an unreadable payload is judged by speed */ }
  return (row.speedKmh ?? Number.POSITIVE_INFINITY) <= STOPPED_SPEED_KMH;
};

/** The point the truck stood at during a stay, from its standing GPS points; null when the stay is too short to tell. */
export function stayPoint(rows: Row[], stop: { latitude: number; longitude: number }, radiusMeters: number): { latitude: number; longitude: number; points: number } | null {
  const inside = rows.filter((row) => standing(row) && distanceMeters(row.latitude, row.longitude, stop.latitude, stop.longitude) <= radiusMeters);
  if (inside.length < MIN_STANDING_POINTS) return null;
  const times = inside.map((row) => row.recordedAt.getTime());
  if ((Math.max(...times) - Math.min(...times)) / 1000 < MIN_STANDING_SECONDS) return null;
  return { latitude: Math.round(median(inside.map((row) => row.latitude)) * 1e6) / 1e6, longitude: Math.round(median(inside.map((row) => row.longitude)) * 1e6) / 1e6, points: inside.length };
}

/** The door a stop names: street with house number and postcode, else the company in its town. */
export function placeKey(stop: { company: string | null; address: string; city: string | null }): { key: string; street: string | null; postalCode: string | null } | null {
  const company = (stop.company ?? '').trim();
  const postalCode = stop.address.match(/\b\d{5}\b/)?.[0] ?? stop.city?.match(/\b\d{5}\b/)?.[0] ?? null;
  const street = stop.address.split(',')[0].trim();
  const door = streetKey(street);
  if (door && postalCode) return { key: `${postalCode}|${door}`, street, postalCode };
  const town = (stop.city ?? '').replace(/\b\d{5}\b/g, '').trim().toLowerCase();
  if (company.length < 3 || !(postalCode || town)) return null;
  return { key: `${postalCode ?? town}|${company.toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim()}`, street: null, postalCode };
}

export type LearnResult = 'LEARNED' | 'CONFIRMED' | 'CANDIDATE' | 'ALREADY_THERE' | 'NO_STAY' | 'NOT_A_PLACE';
/** How a place looked before a visit taught it, so that undoing the visit puts it back (null: the visit created it). */
export type PlaceSnapshot = { externalId: string; before: { latitude: number; longitude: number; useCount: number; active: boolean; lastSeenAt: string } | null };
/** A place that just became trusted: where the trucks stand at the door the key names. */
export type LearnedPlace = { externalId: string; key: string; name: string; latitude: number; longitude: number };

type PlaceStop = { id: string; company: string | null; address: string; city: string | null; latitude: number; longitude: number; tour: { vehicleId: string } };

export const stayExternalId = (key: string) => `stay:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;

export class StayPlaces {
  constructor(private readonly db: PrismaClient, private readonly onChange: () => void = () => undefined,
    private readonly onLearned?: (place: LearnedPlace, now: Date) => Promise<unknown>) {}

  /** Called after BELADEN/ENTLADEN. Never throws into the caller's way: the event is recorded with or without it. */
  async learn(stopId: string, now = new Date()): Promise<LearnResult> {
    const stop = await this.db.stop.findUnique({ where: { id: stopId }, include: { tour: { select: { vehicleId: true } } } });
    if (!stop?.completedAt || !stop.arrivedAt) return 'NO_STAY';
    if (!placeKey(stop)) return 'NOT_A_PLACE';
    const radius = Math.min(stop.arrivalRadiusMeters ?? 1000, PLANT_GATE_MAX_METERS);
    const rows = await this.db.vehicleTelemetry.findMany({ where: { vehicleId: stop.tour.vehicleId, provider: 'WEBFLEET', recordedAt: { gte: stop.arrivedAt, lte: stop.completedAt } },
      orderBy: { recordedAt: 'asc' }, take: 2000, select: { latitude: true, longitude: true, speedKmh: true, recordedAt: true, rawJson: true } });
    const point = stayPoint(rows, stop, radius);
    if (!point) return 'NO_STAY';
    return this.teach(stop, point, stop.arrivedAt, now);
  }

  /**
   * A visit found away from the stop's address (the truck stood at the real gate): the stay's point teaches the place of
   * every stop of that visit. Returns how the places looked before, for «Отменить».
   */
  async learnVisit(stopIds: string[], point: { latitude: number; longitude: number }, visitAt: Date, now = new Date()): Promise<PlaceSnapshot[]> {
    const snapshots: PlaceSnapshot[] = [];
    for (const id of stopIds) {
      const stop = await this.db.stop.findUnique({ where: { id }, include: { tour: { select: { vehicleId: true } } } });
      if (stop) await this.teach(stop, point, visitAt, now, snapshots);
    }
    return snapshots;
  }

  /**
   * A visit found away from the address, recorded automatically: the stay teaches the place, and how the places looked
   * before is kept with the visit so that «Отменить» on the event can take the lesson back.
   */
  async learnOffsiteVisit(stopIds: string[], point: { latitude: number; longitude: number }, visitAt: Date, now = new Date()) {
    const snapshots = await this.learnVisit(stopIds, point, visitAt, now);
    const stop = await this.db.stop.findUnique({ where: { id: stopIds[0] }, select: { tourId: true, tour: { select: { vehicleId: true } } } });
    if (stop && snapshots.length) {
      await this.db.operationEvent.create({ data: { vehicleId: stop.tour.vehicleId, tourId: stop.tourId, stopId: stopIds[0], type: 'STAY_PLACE_VISIT',
        payloadJson: JSON.stringify({ stopIds, point, snapshots }), createdAt: now } });
    }
    return snapshots;
  }

  /** The automatic event of these stops was undone: the lesson of its visit is taken back, once. */
  async forgetVisitOf(stopIds: string[], now = new Date()) {
    const visit = await this.db.operationEvent.findFirst({ where: { stopId: { in: stopIds }, type: 'STAY_PLACE_VISIT' }, orderBy: { createdAt: 'desc' } });
    if (!visit) return false;
    const undone = await this.db.operationEvent.findFirst({ where: { stopId: visit.stopId, type: 'STAY_PLACE_VISIT_FORGOTTEN', createdAt: { gte: visit.createdAt } } });
    if (undone) return false;
    const { snapshots } = JSON.parse(visit.payloadJson) as { snapshots: PlaceSnapshot[] };
    await this.forget(snapshots);
    await this.db.operationEvent.create({ data: { vehicleId: visit.vehicleId, tourId: visit.tourId, stopId: visit.stopId, type: 'STAY_PLACE_VISIT_FORGOTTEN',
      payloadJson: JSON.stringify({ visitId: visit.id }), createdAt: now } });
    await writeAuditLog(this.db, { role: 'system', sessionId: 'stay-places' }, { action: 'STAY_PLACE_VISIT_FORGOTTEN', entityType: 'Stop', entityId: visit.stopId ?? visit.id,
      vehicleId: visit.vehicleId, tourId: visit.tourId, stopId: visit.stopId, metadata: { places: snapshots.map((item) => item.externalId) }, createdAt: now });
    return true;
  }

  /** Undo the visits of an automatic event that was taken back: the places return to how they were before it. */
  async forget(snapshots: PlaceSnapshot[]) {
    for (const snapshot of snapshots) {
      if (!snapshot.before) await this.db.knownAddress.deleteMany({ where: { source: STAY_SOURCE, externalId: snapshot.externalId } });
      else await this.db.knownAddress.updateMany({ where: { source: STAY_SOURCE, externalId: snapshot.externalId }, data: { latitude: snapshot.before.latitude,
        longitude: snapshot.before.longitude, useCount: snapshot.before.useCount, active: snapshot.before.active, lastSeenAt: new Date(snapshot.before.lastSeenAt) } });
    }
    if (snapshots.length) this.onChange();
  }

  /** Where trucks stood at this stop's place before: the trusted gate or the single stay that waits for a second one. */
  async gatesOf(stopId: string): Promise<Array<{ latitude: number; longitude: number }>> {
    const stop = await this.db.stop.findUnique({ where: { id: stopId }, select: { company: true, address: true, city: true } });
    const key = stop ? placeKey(stop) : null;
    if (!key) return [];
    return this.db.knownAddress.findMany({ where: { source: STAY_SOURCE, externalId: stayExternalId(key.key) }, select: { latitude: true, longitude: true } });
  }

  private async teach(stop: PlaceStop, point: { latitude: number; longitude: number }, visitAt: Date, now: Date, snapshots?: PlaceSnapshot[]): Promise<LearnResult> {
    const key = placeKey(stop);
    if (!key) return 'NOT_A_PLACE';
    const externalId = stayExternalId(key.key);
    const existing = await this.db.knownAddress.findFirst({ where: { source: STAY_SOURCE, externalId } });
    if (!existing && distanceMeters(point.latitude, point.longitude, stop.latitude, stop.longitude) <= ALREADY_THERE_METERS) return 'ALREADY_THERE';
    if (snapshots && !snapshots.some((item) => item.externalId === externalId)) {
      snapshots.push({ externalId, before: existing ? { latitude: existing.latitude, longitude: existing.longitude, useCount: existing.useCount,
        active: existing.active, lastSeenAt: existing.lastSeenAt.toISOString() } : null });
    }

    const city = (stop.city ?? '').replace(/\b\d{5}\b/g, '').trim() || null;
    const name = (stop.company ?? stop.address).trim().slice(0, 200);
    const base = { name, street: key.street?.slice(0, 200) ?? null, postalCode: key.postalCode, city: city?.slice(0, 200) ?? null,
      searchText: addressSearchText({ name, name2: null, street: key.street, postalCode: key.postalCode, city }, []), lastSeenAt: now };
    let result: LearnResult;
    let at = point;
    if (!existing) {
      await this.db.knownAddress.create({ data: { ...base, source: STAY_SOURCE, externalId, latitude: point.latitude, longitude: point.longitude, active: false, useCount: 1 } });
      result = 'CANDIDATE';
    } else if (distanceMeters(point.latitude, point.longitude, existing.latitude, existing.longitude) <= AGREE_METERS) {
      // The unloading and the Leergut loading of one visit are one stay, not two that agree.
      if (existing.lastSeenAt.getTime() >= visitAt.getTime() - SAME_VISIT_MS) {
        await this.db.knownAddress.update({ where: { id: existing.id }, data: { lastSeenAt: now } });
        return existing.active ? 'CONFIRMED' : 'CANDIDATE';
      }
      // Stays that agree are averaged: the point settles where the trucks really stand.
      const count = existing.useCount + 1;
      const trusted = count >= STAYS_TO_TRUST;
      at = { latitude: Math.round(((existing.latitude * existing.useCount + point.latitude) / count) * 1e6) / 1e6,
        longitude: Math.round(((existing.longitude * existing.useCount + point.longitude) / count) * 1e6) / 1e6 };
      await this.db.knownAddress.update({ where: { id: existing.id }, data: { ...base, useCount: count, active: trusted || existing.active, ...at } });
      result = existing.active ? 'CONFIRMED' : trusted ? 'LEARNED' : 'CANDIDATE';
    } else if (existing.active) {
      // A place two stays agreed on is not undone by one stay elsewhere (a parking place nearby, a queue on the road).
      return 'CONFIRMED';
    } else {
      // A single earlier stay that does not agree starts over: it was not the gate, or this one is not.
      await this.db.knownAddress.update({ where: { id: existing.id }, data: { ...base, latitude: point.latitude, longitude: point.longitude, active: false, useCount: 1 } });
      result = 'CANDIDATE';
    }
    if (result === 'LEARNED') {
      await writeAuditLog(this.db, { role: 'system', sessionId: 'stay-places' }, { action: 'STAY_PLACE_LEARNED', entityType: 'KnownAddress', entityId: externalId,
        stopId: stop.id, vehicleId: stop.tour.vehicleId, metadata: { postalCode: key.postalCode, city, metersFromStop: Math.round(distanceMeters(point.latitude, point.longitude, stop.latitude, stop.longitude)) }, createdAt: now });
    }
    if (result === 'LEARNED' || existing?.active) this.onChange();
    // Stops already planned at this door move to the gate; a failure there never undoes the learning.
    if (result === 'LEARNED' && this.onLearned) await this.onLearned({ externalId, key: key.key, name, ...at }, now).catch(() => undefined);
    return result;
  }
}
