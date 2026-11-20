import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { BaseVisits, parseTruckNumbers, roughDriveSeconds, visitState, weekKeyOf, weekTimes } from '../src/services/base-visits.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;
let visits: BaseVisits;
const admin = { role: 'admin' as const, sessionId: 's', dispatcherId: undefined };
const BASE = { address: 'Musterweg 1, 37154 Northeim', latitude: 51.7, longitude: 10.0, radiusMeters: 500 };
const WEEK = '2026-11-16';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-base-visits-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
  visits = new BaseVisits(asAppDatabase(db));
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
beforeEach(async () => {
  await db.notification.deleteMany(); await db.auditLog.deleteMany(); await db.vehicleTelemetry.deleteMany(); await db.baseVisit.deleteMany(); await db.appSetting.deleteMany(); await db.vehicle.deleteMany();
  for (const vehicleNumber of ['125', '997', '430']) await db.vehicle.create({ data: { vehicleNumber, licensePlate: `NOM-FX ${vehicleNumber}` } });
});

const gps = async (vehicleNumber: string, at: string, latitude: number, speedKmh: number, standstill = speedKmh === 0) => {
  const vehicle = await db.vehicle.findUniqueOrThrow({ where: { vehicleNumber } });
  await db.vehicleTelemetry.create({ data: { vehicleId: vehicle.id, provider: 'WEBFLEET', externalId: vehicleNumber, latitude, longitude: 10.0, speedKmh,
    recordedAt: new Date(at), receivedAt: new Date(at), rawJson: JSON.stringify({ standstill, lastContactAt: at }) } });
};

describe('the week and the list', () => {
  it('starts the week on the Berlin Monday', () => {
    expect(weekKeyOf(new Date('2026-11-20T12:00:00Z'))).toBe('2026-11-16');
    expect(weekKeyOf(new Date('2026-11-16T05:00:00Z'))).toBe('2026-11-16');
    // Sunday 23:30 UTC is already Monday in Berlin.
    expect(weekKeyOf(new Date('2026-11-22T23:30:00Z'))).toBe('2026-11-23');
  });
  it('is due on Friday 18:00 and free again on Monday 06:00, Berlin time', () => {
    expect(weekTimes(WEEK)).toEqual({ dueAt: new Date('2026-11-20T17:00:00.000Z'), freeAt: new Date('2026-11-23T05:00:00.000Z') });
  });
  it('reads the list as the owner types it', () => {
    expect(parseTruckNumbers('125, LKW 997;430\n125  lkw430')).toEqual(['125', '997', '430']);
    expect(parseTruckNumbers('  ')).toEqual([]);
  });
  it('estimates the way home with the 45 min pause after 4 h 30', () => {
    expect(roughDriveSeconds(0)).toBe(0);
    expect(roughDriveSeconds(100_000)).toBeGreaterThan(6500);
    expect(roughDriveSeconds(100_000)).toBeLessThan(7300);
    expect(roughDriveSeconds(400_000) - 4 * roughDriveSeconds(100_000)).toBeGreaterThanOrEqual(45 * 60 - 4);
  });
  it('tells due, tight, overdue and at the base apart', () => {
    const dueAt = new Date('2026-11-20T17:00:00Z');
    const now = new Date('2026-11-19T10:00:00Z');
    expect(visitState({ dueAt, arrivedAt: null }, new Date('2026-11-20T12:00:00Z'), now)).toBe('DUE');
    expect(visitState({ dueAt, arrivedAt: null }, null, now)).toBe('DUE');
    expect(visitState({ dueAt, arrivedAt: null }, new Date('2026-11-21T09:00:00Z'), now)).toBe('TIGHT');
    expect(visitState({ dueAt, arrivedAt: null }, null, new Date('2026-11-20T18:00:00Z'))).toBe('OVERDUE');
    expect(visitState({ dueAt, arrivedAt: now }, null, new Date('2026-11-21T18:00:00Z'))).toBe('AT_BASE');
  });

  it('replaces the week with the new list and keeps what happened', async () => {
    const first = await visits.setWeek(WEEK, ['125', '997', '555'], null, admin);
    expect(first.trucks.map((truck) => truck.vehicleNumber)).toEqual(['125', '997']);
    expect(first).toMatchObject({ added: ['125', '997'], removed: [], unknown: ['555'], dueAt: '2026-11-20T17:00:00.000Z' });
    await visits.markArrived(first.trucks[0].id, new Date('2026-11-19T15:00:00Z'), admin, new Date('2026-11-19T16:00:00Z'));
    const second = await visits.setWeek(WEEK, ['125', 'NOM FX430'], new Date('2026-11-21T11:00:00Z'), admin);
    expect(second).toMatchObject({ added: ['430'], removed: ['997'], unknown: [], dueAt: '2026-11-21T11:00:00.000Z' });
    expect(second.trucks).toMatchObject([{ vehicleNumber: '125', arrivedAt: '2026-11-19T15:00:00.000Z', arrivedSource: 'DISPATCHER' }, { vehicleNumber: '430', arrivedAt: null }]);
    // The truck taken off the list keeps its row; back on the list it is the same row again.
    expect(await db.baseVisit.count()).toBe(3);
    expect((await visits.setWeek(WEEK, ['125', '430', '997'], null, admin)).added).toEqual(['997']);
    expect(await db.baseVisit.count()).toBe(3);
    expect(await db.auditLog.count({ where: { action: 'BASE_WEEK_UPDATED' } })).toBe(3);
    await expect(visits.setWeek('2026-11-17', ['125'], null, admin)).rejects.toThrow('понедельника');
    await expect(visits.setWeek(WEEK, ['125'], new Date('2026-11-25T11:00:00Z'), admin)).rejects.toThrow('внутри');
  });

  it('shows a truck its week from Monday until it works again', async () => {
    await visits.setWeek(WEEK, ['125'], null, admin);
    const ids = (await db.vehicle.findMany()).map((vehicle) => vehicle.id);
    expect((await visits.current(ids, new Date('2026-11-18T10:00:00Z'))).size).toBe(1);
    expect((await visits.current(ids, new Date('2026-11-22T20:00:00Z'))).size).toBe(1);
    expect((await visits.current(ids, new Date('2026-11-23T05:00:00Z'))).size).toBe(0);
    expect((await visits.current(ids, new Date('2026-11-15T20:00:00Z'))).size).toBe(0);
  });
});

describe('the arrival at the base', () => {
  const now = new Date('2026-11-20T15:00:00Z');
  beforeEach(async () => { await visits.setBase(BASE, admin); await visits.setWeek(WEEK, ['125'], null, admin); });

  it('records a truck that stands in the yard for 20 min, from the moment it drove in', async () => {
    await gps('125', '2026-11-20T14:20:00Z', 51.75, 70);
    await gps('125', '2026-11-20T14:30:00Z', 51.7005, 12);
    for (const minute of [32, 40, 48, 56]) await gps('125', `2026-11-20T14:${minute}:00Z`, 51.7001, 0);
    expect(await visits.detect(now)).toHaveLength(1);
    const visit = await db.baseVisit.findFirstOrThrow();
    expect(visit).toMatchObject({ arrivedAt: new Date('2026-11-20T14:30:00Z'), arrivedSource: 'WEBFLEET_AUTO', arrivedByDispatcherId: null });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: 'BASE_ARRIVAL_AUTO' } })).toMatchObject({ actorRole: 'system', vehicleId: visit.vehicleId });
    expect(await db.notification.findFirstOrThrow()).toMatchObject({ type: 'BASE_ARRIVAL', message: 'LKW 125 на базе.', acknowledgedAt: null });
    expect(await visits.detect(now)).toEqual([]);
    // «Отменить»: the truck is expected again, the notification is closed, both entries stay in the log.
    await visits.revertArrival(visit.id, admin);
    expect(await db.baseVisit.findFirstOrThrow()).toMatchObject({ arrivedAt: null, arrivedSource: null });
    expect((await db.notification.findFirstOrThrow()).acknowledgedAt).not.toBeNull();
    expect(await db.auditLog.count({ where: { action: { in: ['BASE_ARRIVAL_AUTO', 'BASE_ARRIVAL_REVERTED'] } } })).toBe(2);
  });

  it('records nothing for a drive past the gate, a short stop, a stale position or a truck that is not on the list', async () => {
    await gps('125', '2026-11-20T14:50:00Z', 51.7003, 30);
    await gps('125', '2026-11-20T14:56:00Z', 51.7001, 0);
    expect(await visits.detect(now)).toEqual([]);
    await db.vehicleTelemetry.deleteMany();
    // Stood for an hour, but the last sign of the unit is three hours old.
    for (const minute of ['00', '20', '40', '59']) await gps('125', `2026-11-20T11:${minute}:00Z`, 51.7001, 0);
    expect(await visits.detect(now)).toEqual([]);
    for (const minute of [30, 40, 50, 58]) await gps('997', `2026-11-20T14:${minute}:00Z`, 51.7001, 0);
    expect(await visits.detect(now)).toEqual([]);
    expect(await db.notification.count()).toBe(0);
  });

  it('records nothing without a base and lets a dispatcher mark the truck by hand', async () => {
    await db.appSetting.deleteMany();
    for (const minute of [30, 40, 50, 58]) await gps('125', `2026-11-20T14:${minute}:00Z`, 51.7001, 0);
    expect(await visits.detect(now)).toEqual([]);
    const visit = await db.baseVisit.findFirstOrThrow();
    await expect(visits.markArrived(visit.id, new Date('2026-11-20T16:00:00Z'), admin, now)).rejects.toThrow('не в будущем');
    await visits.markArrived(visit.id, now, admin, now);
    expect(visits.view(await db.baseVisit.findFirstOrThrow(), null, now)).toMatchObject({ state: 'AT_BASE', arrivedSource: 'DISPATCHER', expectedAt: null, freeAt: '2026-11-23T05:00:00.000Z' });
  });

  it('expects the truck at the base after its last stop', () => {
    const at = new Date('2026-11-20T10:00:00Z');
    const expected = visits.expectedAt(BASE, { latitude: 52.6, longitude: 10.0, at })!;
    expect((expected.getTime() - at.getTime()) / 3600_000).toBeGreaterThan(1.7);
    expect((expected.getTime() - at.getTime()) / 3600_000).toBeLessThan(2.2);
    expect(visits.expectedAt(null, { latitude: 52.6, longitude: 10.0, at })).toBeNull();
    expect(visits.expectedAt(BASE, null)).toBeNull();
  });
});
