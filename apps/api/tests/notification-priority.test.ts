import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { buildApp } from '../src/app.js';
import { prioritize, stackByTruck, type PriorityFacts, type StopFacts } from '../src/services/notification-priority.js';
import { NotificationService } from '../src/services/notifications.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { TourService } from '../src/services/tours.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

const now = new Date('2026-11-05T06:05:00Z');
const night = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 5, hour, minute));
const note = (id: string, type: string, extra: { stopId?: string; vehicleId?: string; payload?: object; createdAt?: Date } = {}) => ({
  id, type, vehicleId: extra.vehicleId ?? 'v1', stopId: extra.stopId ?? null,
  payloadJson: JSON.stringify(extra.payload ?? {}), createdAt: extra.createdAt ?? night(1)
});
const stop = (id: string, extra: Partial<StopFacts> = {}): StopFacts => ({ id, type: 'LOAD', arrivedAt: null, completedAt: null, appointmentAt: null, appointmentWindowStartAt: null, ...extra });
const facts = (stops: StopFacts[], legs: Array<[string, string]> = []): PriorityFacts => ({ stops: new Map(stops.map((item) => [item.id, item])), legTarget: new Map(legs) });

describe('notification priority after the night', () => {
  it('puts decisions first, then risks, then information; urgent decisions lead', () => {
    const list = prioritize([
      note('arrival', 'AUTO_ARRIVAL', { stopId: 's1' }),
      note('jam', 'TRAFFIC_DELAY', { stopId: 's2' }),
      note('termin', 'APPOINTMENT_MATCH', { createdAt: night(0) }),
      note('left', 'STOP_DEPARTED', { stopId: 's3', createdAt: night(3) }),
      note('rest', 'DAILY_REST_AT_STOP', { stopId: 's4', payload: { until: '2026-11-05T09:00:00Z' } })
    ], facts([stop('s1', { arrivedAt: night(1) }), stop('s2'), stop('s3', { arrivedAt: night(2) }), stop('s4', { arrivedAt: night(0) })]), now);
    expect(list.map((item) => [item.id, item.priority, item.urgent])).toEqual([
      ['left', 'ACTION', true], ['termin', 'ACTION', false], ['jam', 'RISK', false], ['arrival', 'INFO', false], ['rest', 'INFO', false]
    ]);
    expect(list.every((item) => !item.resolved)).toBe(true);
  });

  it('keeps only the newest jam per stop and moves the older ones down as no longer current', () => {
    const list = prioritize([
      note('jam-1', 'TRAFFIC_DELAY', { stopId: 's1', createdAt: night(1) }),
      note('jam-2', 'TRAFFIC_DELAY', { stopId: 's1', createdAt: night(1, 10) }),
      note('jam-3', 'TRAFFIC_DELAY', { stopId: 's1', createdAt: night(1, 20) })
    ], facts([stop('s1')]), now);
    expect(list.map((item) => [item.id, item.priority, item.resolvedReason])).toEqual([
      ['jam-3', 'RISK', null], ['jam-1', 'INFO', 'есть новее'], ['jam-2', 'INFO', 'есть новее']
    ]);
  });

  it('an automatic BELADEN/ENTLADEN is information to read; once undone it says so', () => {
    const list = prioritize([
      note('auto', 'AUTO_STOP_EVENT', { stopId: 's1' }),
      note('undone', 'AUTO_STOP_EVENT', { stopId: 's2' })
    ], facts([stop('s1', { arrivedAt: night(0), completedAt: night(1) }), stop('s2', { arrivedAt: night(0) })]), now);
    expect(Object.fromEntries(list.map((item) => [item.id, [item.priority, item.urgent, item.resolvedReason]]))).toEqual({
      auto: ['INFO', false, null], undone: ['INFO', false, 'отметка отменена']
    });
  });

  it('marks what the night already settled: BELADEN after the arrival, the truck on the stop after a jam or a deviation, the rest that ended', () => {
    const list = prioritize([
      note('arrival', 'AUTO_ARRIVAL', { stopId: 's1' }),
      note('dwell', 'LONG_DWELL', { stopId: 's1', payload: { severity: 'CRITICAL' } }),
      note('jam', 'TRAFFIC_DELAY', { stopId: 's2' }),
      note('off', 'ROUTE_DEVIATION', { payload: { legId: 'l2' } }),
      note('rest', 'DAILY_REST_AT_STOP', { stopId: 's3', payload: { until: '2026-11-05T05:00:00Z' } })
    ], facts([stop('s1', { arrivedAt: night(0), completedAt: night(2) }), stop('s2', { type: 'UNLOAD', arrivedAt: night(4) }), stop('s3', { arrivedAt: night(0) })], [['l2', 's2']]), now);
    expect(Object.fromEntries(list.map((item) => [item.id, [item.priority, item.urgent, item.resolvedReason]]))).toEqual({
      arrival: ['INFO', false, 'BELADEN уже отмечен'], dwell: ['INFO', false, 'BELADEN уже отмечен'],
      jam: ['INFO', false, 'машина уже на точке'], off: ['INFO', false, 'машина уже на точке'], rest: ['INFO', false, 'отдых закончился']
    });
  });

  it('within a group the stop with the nearest Termin comes first; a critical stop rings as urgent, a warning is a risk', () => {
    const list = prioritize([
      note('later', 'LONG_DWELL', { stopId: 's1', payload: { severity: 'WARNING' } }),
      note('sooner', 'LONG_DWELL', { stopId: 's2', payload: { severity: 'WARNING' } }),
      note('critical', 'LONG_DWELL', { stopId: 's3', payload: { severity: 'CRITICAL' } }),
      note('late', 'TERMIN_MET', { stopId: 's3', payload: { onTime: false } }),
      note('onTime', 'TERMIN_MET', { stopId: 's3', payload: { onTime: true } })
    ], facts([
      stop('s1', { arrivedAt: night(0), appointmentAt: night(10) }),
      stop('s2', { arrivedAt: night(0), appointmentWindowStartAt: night(7) }),
      stop('s3', { arrivedAt: night(0) })
    ]), now);
    expect(list.map((item) => [item.id, item.priority, item.urgent])).toEqual([
      ['critical', 'ACTION', true], ['sooner', 'RISK', false], ['later', 'RISK', false], ['late', 'RISK', false], ['onTime', 'INFO', false]
    ]);
  });
});

describe('one card per truck', () => {
  const jams = (vehicleId: string, count: number) => Array.from({ length: count }, (_, index) => note(`${vehicleId}-jam-${index}`, 'TRAFFIC_DELAY', { vehicleId, stopId: `${vehicleId}-s${index}`, createdAt: night(0, index) }));

  it('leads with the newest notification and folds the other notifications of the truck under it', () => {
    const list = stackByTruck(prioritize([...jams('v1', 20), note('v2-rest', 'DAILY_REST_AT_STOP', { vehicleId: 'v2', stopId: 'x' })], facts([]), now));
    const leads = list.filter((item) => item.leadId === item.id);
    expect(leads.map((item) => [item.id, item.stackSize])).toEqual([['v1-jam-19', 20], ['v2-rest', 1]]);
    expect(list.filter((item) => item.vehicleId === 'v1').every((item) => item.leadId === 'v1-jam-19')).toBe(true);
  });

  it('keeps an open decision on top, the one that needs an answer first, never a newer piece of information', () => {
    const left = note('left', 'STOP_DEPARTED', { stopId: 's-left', createdAt: night(0) });
    const deviation = note('deviation', 'ROUTE_DEVIATION', { payload: { legId: 'l1' }, createdAt: night(1) });
    const list = stackByTruck(prioritize([left, deviation, ...jams('v1', 3).map((item) => ({ ...item, createdAt: night(4) }))], facts([stop('s-left', { arrivedAt: night(0) })]), now));
    expect(new Set(list.map((item) => item.leadId))).toEqual(new Set(['left']));
    // Once BELADEN is recorded the departure no longer needs an answer: the open deviation leads.
    const settled = stackByTruck(prioritize([left, deviation, ...jams('v1', 3)], facts([stop('s-left', { arrivedAt: night(0), completedAt: night(0, 30) })]), now));
    expect(settled[0].leadId).toBe('deviation');
    // Only settled or informational items left: the newest one leads.
    const quiet = stackByTruck(prioritize([{ ...left, createdAt: night(5) }, ...jams('v1', 3)], facts([stop('s-left', { arrivedAt: night(0), completedAt: night(0, 30) })]), now));
    expect(quiet[0].leadId).toBe('left');
  });
});

describe('reading the information block at once', () => {
  let db: PrismaClient;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-priority-test-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
  }, 20000);
  afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it('closes only the given open items and returns the list in priority order', async () => {
    const service = new NotificationService(asAppDatabase(db), new TourService(asAppDatabase(db), new MockRoutingProvider()));
    for (const [key, type] of [['a', 'AUTO_ARRIVAL'], ['b', 'TERMIN_MET'], ['c', 'STOP_DEPARTED']] as const) {
      await service.publish({ dedupKey: `p-${key}`, vehicleId: 'v1', type, message: key, payload: type === 'TERMIN_MET' ? { onTime: true } : {} });
    }
    expect((await service.list(now)).map((item) => item.message)).toEqual(['c', 'a', 'b']);
    const ids = (await service.list(now)).filter((item) => item.priority === 'INFO').map((item) => item.id);
    expect((await service.acknowledgeMany(ids)).count).toBe(2);
    expect((await service.acknowledgeMany(ids)).count).toBe(0);
    expect((await service.list(now)).map((item) => item.message)).toEqual(['c']);
  });

  it('validates the ids of «Прочитать все» before touching data', async () => {
    const app = await buildApp({ auth: { disabled: true } });
    try {
      const send = (payload: object) => app.inject({ method: 'POST', url: '/notifications/ack-many', payload });
      expect((await send({ ids: [] })).statusCode).toBe(400);
      expect((await send({ ids: Array.from({ length: 301 }, (_, index) => `n${index}`) })).statusCode).toBe(400);
      expect((await send({ ids: 'all' })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
