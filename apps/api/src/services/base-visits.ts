import type { PrismaClient } from '@prisma/client';
import { berlinLocalToDate } from './appointment-match.js';
import { writeAuditLog, type AuditActor } from './audit-log.js';
import { berlinToday } from './order-dates.js';
import { distanceMeters, positionFreshness, zoneStay } from './webfleet.js';

/** The base is a yard: the truck stands at it, not near it. */
export const BASE_RADIUS_METERS = 500;
/** As for BELADEN/ENTLADEN: a stay this long is a real stop, not a drive past the gate. */
export const BASE_MIN_STAY_SECONDS = 20 * 60;
/** Friday evening unless the admin names another moment with the list. */
export const BASE_DUE = { weekday: 5, time: '18:00' } as const;
/** «В понедельник утром она снова работает» (owner, 20.11.2026). */
export const BASE_FREE_TIME = '06:00';
const BASE_KEY = 'BASE';
const HISTORY_SECONDS = 6 * 3600;
const HISTORY_ROWS = 400;
const SYSTEM_ACTOR: AuditActor = { role: 'system', sessionId: 'webfleet-auto' };

export type BasePlace = { address: string; latitude: number; longitude: number; radiusMeters: number };
export type BaseVisitView = {
  id: string; weekStart: string; dueAt: string; freeAt: string; arrivedAt: string | null; arrivedSource: string | null;
  /** When the truck can stand at the base after its last planned stop; an estimate by distance, null when it cannot be told. */
  expectedAt: string | null;
  state: 'AT_BASE' | 'DUE' | 'TIGHT' | 'OVERDUE';
};

const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (key: string, days: number) => dayKey(new Date(Date.parse(`${key}T00:00:00.000Z`) + days * 86_400_000));

/** Monday of the Berlin week of `now`, as «YYYY-MM-DD». */
export function weekKeyOf(now: Date): string {
  const today = berlinToday(now);
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay() || 7;
  return addDays(today, 1 - weekday);
}
export const weekStartOf = (weekKey: string) => new Date(`${weekKey}T00:00:00.000Z`);
export function isWeekKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).getUTCDay() === 1;
}
/** The default deadline of a week and the moment the trucks work again, in Berlin time. */
export function weekTimes(weekKey: string) {
  return { dueAt: berlinLocalToDate(`${addDays(weekKey, BASE_DUE.weekday - 1)}T${BASE_DUE.time}`)!, freeAt: berlinLocalToDate(`${addDays(weekKey, 7)}T${BASE_FREE_TIME}`)! };
}

/** «125, LKW 997; 430» → ['125', '997', '430']: the list as the owner sends it, one number per truck, no doubles. */
export function parseTruckNumbers(text: string): string[] {
  const found = text.split(/[\s,;]+/).map((part) => part.replace(/^lkw/i, '').trim().toUpperCase()).filter((part) => part && part !== 'LKW');
  return [...new Set(found)];
}

/**
 * Driving time over a distance the router was not asked for: the straight line is stretched to a road and the 45 min
 * pause comes after every 4 h 30 of it. An estimate for a warning, never an ETA.
 */
export function roughDriveSeconds(straightMeters: number): number {
  const driving = straightMeters * 1.3 / (68 / 3.6);
  return Math.round(driving + Math.floor(driving / (4.5 * 3600)) * 45 * 60);
}

export function visitState(visit: { dueAt: Date; arrivedAt: Date | null }, expectedAt: Date | null, now: Date): BaseVisitView['state'] {
  if (visit.arrivedAt) return 'AT_BASE';
  if (now > visit.dueAt) return 'OVERDUE';
  return expectedAt && expectedAt > visit.dueAt ? 'TIGHT' : 'DUE';
}

export class BaseVisits {
  constructor(private readonly db: PrismaClient) {}

  async base(): Promise<BasePlace | null> {
    const row = await this.db.appSetting.findUnique({ where: { key: BASE_KEY } });
    if (!row) return null;
    try {
      const value = JSON.parse(row.valueJson) as Partial<BasePlace>;
      if (typeof value.address !== 'string' || typeof value.latitude !== 'number' || typeof value.longitude !== 'number') return null;
      return { address: value.address, latitude: value.latitude, longitude: value.longitude, radiusMeters: typeof value.radiusMeters === 'number' ? value.radiusMeters : BASE_RADIUS_METERS };
    } catch { return null; }
  }

  async setBase(place: BasePlace, actor: AuditActor) {
    const valueJson = JSON.stringify(place);
    await this.db.appSetting.upsert({ where: { key: BASE_KEY }, create: { key: BASE_KEY, valueJson, updatedByDispatcherId: actor.dispatcherId ?? null }, update: { valueJson, updatedByDispatcherId: actor.dispatcherId ?? null } });
    await writeAuditLog(this.db, actor, { action: 'BASE_PLACE_UPDATED', entityType: 'AppSetting', entityId: BASE_KEY, metadata: place });
    return place;
  }

  /** The list of one week, the trucks that are on it, in the order of their numbers. */
  async week(weekKey: string) {
    const rows = await this.db.baseVisit.findMany({ where: { weekStart: weekStartOf(weekKey), cancelledAt: null }, include: { vehicle: { select: { vehicleNumber: true, licensePlate: true } } } });
    const times = weekTimes(weekKey);
    return {
      weekStart: weekKey, dueAt: (rows[0]?.dueAt ?? times.dueAt).toISOString(), freeAt: times.freeAt.toISOString(),
      trucks: rows.map((row) => ({ id: row.id, vehicleId: row.vehicleId, vehicleNumber: row.vehicle.vehicleNumber, licensePlate: row.vehicle.licensePlate,
        arrivedAt: row.arrivedAt?.toISOString() ?? null, arrivedSource: row.arrivedSource }))
        .sort((a, b) => a.vehicleNumber.localeCompare(b.vehicleNumber, 'de', { numeric: true }))
    };
  }

  /**
   * The owner's list replaces the week: new trucks are added, trucks no longer on it are taken off (the row stays),
   * a truck that already stood at the base keeps its arrival. Numbers that match no truck come back, nothing is guessed.
   */
  async setWeek(weekKey: string, numbers: string[], dueAt: Date | null, actor: AuditActor) {
    if (!isWeekKey(weekKey)) throw fail('Неделя начинается с понедельника.', 400);
    const weekStart = weekStartOf(weekKey);
    const times = weekTimes(weekKey);
    const due = dueAt ?? times.dueAt;
    if (due < weekStart || due >= times.freeAt) throw fail('Срок должен быть внутри этой недели.', 400);
    const vehicles = await this.db.vehicle.findMany({ select: { id: true, vehicleNumber: true, licensePlate: true } });
    const plate = (value: string | null) => (value ?? '').toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, '');
    const matched = new Map<string, string>();
    const unknown: string[] = [];
    for (const number of numbers) {
      const hits = vehicles.filter((vehicle) => vehicle.vehicleNumber.trim().toUpperCase() === number || (plate(vehicle.licensePlate) && plate(vehicle.licensePlate) === plate(number)));
      if (hits.length === 1) matched.set(hits[0].id, hits[0].vehicleNumber); else unknown.push(number);
    }
    const existing = await this.db.baseVisit.findMany({ where: { weekStart } });
    const added: string[] = [];
    const removed: string[] = [];
    await this.db.$transaction(async (tx) => {
      for (const [vehicleId, number] of matched) {
        const row = existing.find((item) => item.vehicleId === vehicleId);
        if (!row) { await tx.baseVisit.create({ data: { vehicleId, weekStart, dueAt: due, freeAt: times.freeAt, createdByDispatcherId: actor.dispatcherId ?? null } }); added.push(number); }
        else {
          if (row.cancelledAt) added.push(number);
          await tx.baseVisit.update({ where: { id: row.id }, data: { dueAt: due, cancelledAt: null, cancelledByDispatcherId: null } });
        }
      }
      for (const row of existing) {
        if (matched.has(row.vehicleId) || row.cancelledAt) continue;
        await tx.baseVisit.update({ where: { id: row.id }, data: { cancelledAt: new Date(), cancelledByDispatcherId: actor.dispatcherId ?? null } });
        removed.push(vehicles.find((vehicle) => vehicle.id === row.vehicleId)?.vehicleNumber ?? row.vehicleId);
      }
      await writeAuditLog(tx, actor, { action: 'BASE_WEEK_UPDATED', entityType: 'BaseVisit', entityId: weekKey, metadata: { week: weekKey, dueAt: due.toISOString(), trucks: [...matched.values()], added, removed, unknown } });
    });
    return { ...(await this.week(weekKey)), added, removed, unknown };
  }

  /** The open week of each truck: from the Monday of its week until it works again. */
  async current(vehicleIds: string[], now: Date) {
    const rows = vehicleIds.length ? await this.db.baseVisit.findMany({ where: { vehicleId: { in: vehicleIds }, cancelledAt: null, weekStart: { lte: now }, freeAt: { gt: now } } }) : [];
    return new Map(rows.map((row) => [row.vehicleId, row]));
  }

  view(visit: { id: string; weekStart: Date; dueAt: Date; freeAt: Date; arrivedAt: Date | null; arrivedSource: string | null }, expectedAt: Date | null, now: Date): BaseVisitView {
    return { id: visit.id, weekStart: dayKey(visit.weekStart), dueAt: visit.dueAt.toISOString(), freeAt: visit.freeAt.toISOString(), arrivedAt: visit.arrivedAt?.toISOString() ?? null,
      arrivedSource: visit.arrivedSource, expectedAt: visit.arrivedAt ? null : expectedAt?.toISOString() ?? null, state: visitState(visit, expectedAt, now) };
  }

  /** When the truck can be at the base: from where and when it is free, plus the rough drive home. */
  expectedAt(base: BasePlace | null, from: { latitude: number; longitude: number; at: Date } | null): Date | null {
    if (!base || !from) return null;
    return new Date(from.at.getTime() + roughDriveSeconds(distanceMeters(from.latitude, from.longitude, base.latitude, base.longitude)) * 1000);
  }

  async markArrived(id: string, at: Date, actor: AuditActor, now: Date) {
    const visit = await this.db.baseVisit.findUnique({ where: { id } });
    if (!visit || visit.cancelledAt) throw fail('Машины нет в списке на базу.', 404);
    if (visit.arrivedAt) return visit;
    if (at > now || at < visit.weekStart) throw fail('Время заезда должно быть на этой неделе и не в будущем.', 400);
    const system = actor.role === 'system';
    const updated = await this.db.baseVisit.update({ where: { id }, data: { arrivedAt: at, arrivedSource: system ? 'WEBFLEET_AUTO' : 'DISPATCHER', arrivedByDispatcherId: actor.dispatcherId ?? null } });
    await writeAuditLog(this.db, actor, { action: system ? 'BASE_ARRIVAL_AUTO' : 'BASE_ARRIVAL_RECORDED', entityType: 'BaseVisit', entityId: id, vehicleId: visit.vehicleId, metadata: { arrivedAt: at.toISOString(), week: dayKey(visit.weekStart) } });
    return updated;
  }

  /** «Отменить»: the truck is expected at the base again; the audit log keeps both entries. */
  async revertArrival(id: string, actor: AuditActor) {
    const visit = await this.db.baseVisit.findUnique({ where: { id } });
    if (!visit || visit.cancelledAt) throw fail('Машины нет в списке на базу.', 404);
    if (!visit.arrivedAt) return visit;
    const updated = await this.db.baseVisit.update({ where: { id }, data: { arrivedAt: null, arrivedSource: null, arrivedByDispatcherId: null } });
    await writeAuditLog(this.db, actor, { action: 'BASE_ARRIVAL_REVERTED', entityType: 'BaseVisit', entityId: id, vehicleId: visit.vehicleId, metadata: { arrivedAt: visit.arrivedAt.toISOString(), source: visit.arrivedSource } });
    await this.db.notification.updateMany({ where: { dedupKey: `base-arrival:${id}`, acknowledgedAt: null }, data: { acknowledgedAt: new Date() } });
    return updated;
  }

  /**
   * Fresh Webfleet GPS only (CLAUDE.md rule 3): a truck of this week's list that stands in the yard for 20 min is at the
   * base from the moment it drove in. A stale position or a calculated one records nothing.
   */
  async detect(now = new Date()): Promise<string[]> {
    const base = await this.base();
    if (!base) return [];
    const open = await this.db.baseVisit.findMany({ where: { cancelledAt: null, arrivedAt: null, weekStart: { lte: now }, freeAt: { gt: now } }, include: { vehicle: { select: { vehicleNumber: true } } } });
    const recorded: string[] = [];
    for (const visit of open) {
      const since = new Date(Math.max(now.getTime() - HISTORY_SECONDS * 1000, visit.weekStart.getTime()));
      const history = await this.db.vehicleTelemetry.findMany({ where: { vehicleId: visit.vehicleId, provider: 'WEBFLEET', recordedAt: { gte: since, lte: now } }, orderBy: { recordedAt: 'desc' }, take: HISTORY_ROWS });
      const latest = history[0];
      if (!latest) continue;
      const payload = safe(latest.rawJson);
      const contact = typeof payload?.lastContactAt === 'string' ? new Date(payload.lastContactAt) : null;
      const stopped = payload?.standstill === true || (payload?.standstill !== false && typeof latest.speedKmh === 'number' && latest.speedKmh <= 3);
      if (!positionFreshness(latest.recordedAt, contact && !Number.isNaN(contact.getTime()) ? contact : null, stopped, now).fresh) continue;
      if (distanceMeters(latest.latitude, latest.longitude, base.latitude, base.longitude) > base.radiusMeters) continue;
      const zone = { id: 'base', latitude: base.latitude, longitude: base.longitude, arrivalRadiusMeters: base.radiusMeters, type: 'BASE', city: null, address: base.address };
      const stay = zoneStay(history, zone, base.radiusMeters);
      if (!stay) continue;
      // A standing truck keeps its last position: the time since that position counts as standing too.
      const standing = Math.max(stay.longestStandstillSeconds, stopped ? (now.getTime() - stay.enteredAt.getTime()) / 1000 : 0);
      if (standing < BASE_MIN_STAY_SECONDS) continue;
      await this.markArrived(visit.id, stay.enteredAt < visit.weekStart ? visit.weekStart : stay.enteredAt, SYSTEM_ACTOR, now);
      await this.db.notification.upsert({
        where: { dedupKey: `base-arrival:${visit.id}` },
        create: { dedupKey: `base-arrival:${visit.id}`, vehicleId: visit.vehicleId, type: 'BASE_ARRIVAL', message: `LKW ${visit.vehicle.vehicleNumber} на базе.`,
          payloadJson: JSON.stringify({ baseVisitId: visit.id, arrivedAt: stay.enteredAt.toISOString(), freeAt: visit.freeAt.toISOString() }) },
        update: { acknowledgedAt: null, createdAt: now, payloadJson: JSON.stringify({ baseVisitId: visit.id, arrivedAt: stay.enteredAt.toISOString(), freeAt: visit.freeAt.toISOString() }) }
      });
      recorded.push(visit.id);
    }
    return recorded;
  }
}

function safe(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try { const value: unknown = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
