import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { TelemetryRetention, TELEMETRY_SYSTEM_ACTOR, telemetryRetentionDays } from '../src/services/telemetry-retention.js';
import { migrateTestDatabase } from './test-database.js';

const now = new Date('2026-11-08T21:00:00Z');
const daysAgo = (days: number, minutes = 0) => new Date(now.getTime() - days * 86_400_000 - minutes * 60_000);

describe('keeping only the last days of GPS', () => {
  let directory: string;
  let db: PrismaClient;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-telemetry-retention-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
  });
  afterEach(async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); });

  async function truck(number: string, positions: Date[]) {
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: number } });
    for (const recordedAt of positions) {
      await db.vehicleTelemetry.create({ data: { vehicleId: vehicle.id, provider: 'WEBFLEET', externalId: `wf-${number}`, latitude: 51.5, longitude: 9.9, recordedAt, receivedAt: recordedAt } });
    }
    return vehicle;
  }
  const left = async (vehicleId: string) => (await db.vehicleTelemetry.findMany({ where: { vehicleId }, orderBy: { recordedAt: 'asc' } })).map((row) => row.recordedAt);
  const service = (options: ConstructorParameters<typeof TelemetryRetention>[1] = {}) =>
    new TelemetryRetention(db as unknown as PostgresPrismaClient, { days: 5, pause: async () => undefined, ...options });

  it('keeps 5 days by default; the server environment may change it within sane bounds', () => {
    expect(telemetryRetentionDays({})).toBe(5);
    expect(telemetryRetentionDays({ TELEMETRY_RETENTION_DAYS: '30' })).toBe(30);
    for (const wrong of ['0', '-3', '2.5', 'week', '100000']) expect(telemetryRetentionDays({ TELEMETRY_RETENTION_DAYS: wrong })).toBe(5);
  });

  it('deletes positions older than 5 days, keeps recent ones and the last position of a truck that went silent', async () => {
    const moving = await truck('997', [daysAgo(10), daysAgo(6), daysAgo(5, 1), daysAgo(4), daysAgo(0, 1)]);
    const silent = await truck('321', [daysAgo(20), daysAgo(8)]);
    expect(await service().purge(now, TELEMETRY_SYSTEM_ACTOR)).toEqual({ deleted: 4, more: false });
    expect(await left(moving.id)).toEqual([daysAgo(4), daysAgo(0, 1)]);
    expect(await left(silent.id)).toEqual([daysAgo(8)]);

    const audit = await db.auditLog.findMany({ where: { action: 'TELEMETRY_PURGED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorRole).toBe('system');
    expect(JSON.parse(audit[0].metadataJson!)).toMatchObject({ deleted: 4, retentionDays: 5, more: false });

    // Nothing old left: nothing deleted, nothing audited.
    expect(await service().purge(now, TELEMETRY_SYSTEM_ACTOR)).toEqual({ deleted: 0, more: false });
    expect(await db.auditLog.count({ where: { action: 'TELEMETRY_PURGED' } })).toBe(1);
  });

  it('spreads a big backlog over several runs instead of one heavy delete', async () => {
    const backlog = await truck('124', [...Array.from({ length: 7 }, (_, index) => daysAgo(30 - index)), daysAgo(1)]);
    const small = service({ batch: 2, maxBatches: 2 });
    expect(await small.purge(now)).toEqual({ deleted: 4, more: true });
    expect(await small.purge(now)).toEqual({ deleted: 3, more: false });
    expect(await left(backlog.id)).toEqual([daysAgo(1)]);
  });
});
