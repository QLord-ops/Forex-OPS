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

export class StayPlaces {
  constructor(private readonly db: PrismaClient, private readonly onChange: () => void = () => undefined) {}

  /** Called after BELADEN/ENTLADEN. Never throws into the caller's way: the event is recorded with or without it. */
  async learn(stopId: string, now = new Date()): Promise<LearnResult> {
    const stop = await this.db.stop.findUnique({ where: { id: stopId }, include: { tour: { select: { vehicleId: true } } } });
    if (!stop?.completedAt || !stop.arrivedAt) return 'NO_STAY';
    const key = placeKey(stop);
    if (!key) return 'NOT_A_PLACE';
    const radius = Math.min(stop.arrivalRadiusMeters ?? 1000, PLANT_GATE_MAX_METERS);
    const rows = await this.db.vehicleTelemetry.findMany({ where: { vehicleId: stop.tour.vehicleId, provider: 'WEBFLEET', recordedAt: { gte: stop.arrivedAt, lte: stop.completedAt } },
      orderBy: { recordedAt: 'asc' }, take: 2000, select: { latitude: true, longitude: true, speedKmh: true, recordedAt: true, rawJson: true } });
    const point = stayPoint(rows, stop, radius);
    if (!point) return 'NO_STAY';
    const externalId = `stay:${createHash('sha256').update(key.key).digest('hex').slice(0, 24)}`;
    const existing = await this.db.knownAddress.findFirst({ where: { source: STAY_SOURCE, externalId } });
    if (!existing && distanceMeters(point.latitude, point.longitude, stop.latitude, stop.longitude) <= ALREADY_THERE_METERS) return 'ALREADY_THERE';

    const city = (stop.city ?? '').replace(/\b\d{5}\b/g, '').trim() || null;
    const name = (stop.company ?? stop.address).trim().slice(0, 200);
    const base = { name, street: key.street?.slice(0, 200) ?? null, postalCode: key.postalCode, city: city?.slice(0, 200) ?? null,
      searchText: addressSearchText({ name, name2: null, street: key.street, postalCode: key.postalCode, city }, []), lastSeenAt: now };
    let result: LearnResult;
    if (!existing) {
      await this.db.knownAddress.create({ data: { ...base, source: STAY_SOURCE, externalId, latitude: point.latitude, longitude: point.longitude, active: false, useCount: 1 } });
      result = 'CANDIDATE';
    } else if (distanceMeters(point.latitude, point.longitude, existing.latitude, existing.longitude) <= AGREE_METERS) {
      // The unloading and the Leergut loading of one visit are one stay, not two that agree.
      if (existing.lastSeenAt.getTime() >= stop.arrivedAt.getTime() - SAME_VISIT_MS) {
        await this.db.knownAddress.update({ where: { id: existing.id }, data: { lastSeenAt: now } });
        return existing.active ? 'CONFIRMED' : 'CANDIDATE';
      }
      // Stays that agree are averaged: the point settles where the trucks really stand.
      const count = existing.useCount + 1;
      const trusted = count >= STAYS_TO_TRUST;
      await this.db.knownAddress.update({ where: { id: existing.id }, data: { ...base, useCount: count, active: trusted || existing.active,
        latitude: Math.round(((existing.latitude * existing.useCount + point.latitude) / count) * 1e6) / 1e6,
        longitude: Math.round(((existing.longitude * existing.useCount + point.longitude) / count) * 1e6) / 1e6 } });
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
    return result;
  }
}
