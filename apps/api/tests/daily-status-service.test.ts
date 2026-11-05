import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CurrentPosition } from '../src/domain.js';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { registerDailyStatusRoutes } from '../src/routes/daily-status.js';
import { DailyStatusService, type DailyStatusDeps } from '../src/services/daily-status.js';
import { buildStatusWorkbook } from '../src/services/daily-status-export.js';
import { hashDispatcherPassword, registerDispatcherAuth } from '../src/services/dispatcher-auth.js';
import { EtaService } from '../src/services/eta.js';
import type { DriverHours } from '../src/services/webfleet-live.js';
import { migrateTestDatabase } from './test-database.js';

const ORIGIN = 'https://ops.test';
let directory: string;
let db: PrismaClient;
const ids: Record<string, string> = {};
let ready = true;

function deps(startedAt = new Date('2026-11-05T00:00:00Z')): DailyStatusDeps {
  return {
    getPosition: async () => ({ position: { latitude: 52.4, longitude: 9.7 }, positionSource: 'WEBFLEET', telemetryStale: false, remainingDistanceMeters: 0 } as CurrentPosition),
    latestTelemetry: async (id) => ({ address: id === ids.empty ? 'Ingolstädter Str. 3, 85055 Ingolstadt, DE' : 'A7, Hannover', stale: false }),
    driverHours: async () => ({ status: 'NONE', workState: null, activitySince: null, times: null, timesStatus: 'NO_DATA' } as DriverHours),
    coupledTrailerNo: async () => null,
    webfleetReady: () => ready,
    eta: new EtaService(),
    startedAt
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-daily-status-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
  ids.empty = (await db.vehicle.create({ data: { vehicleNumber: '124', line: 'SCHNELLECKE', statusGroup: 'SUED', servicePhone: '49 15904694508', appSped: true } })).id;
  ids.stuck = (await db.vehicle.create({ data: { vehicleNumber: '9724', line: 'SCHNELLECKE', statusGroup: 'NORD' } })).id;
  ids.free = (await db.vehicle.create({ data: { vehicleNumber: '777', line: 'SCHNELLECKE' } })).id;
  ids.tesla = (await db.vehicle.create({ data: { vehicleNumber: '2853', line: 'WALTER_TESLA', statusGroup: 'SUED' } })).id;
  const tour = await db.tour.create({ data: { vehicleId: ids.stuck, orderNumber: '20565507', status: 'ACTIVE', trailerPlate: 'Z-S3280' } });
  await db.stop.create({ data: { tourId: tour.id, sequence: 1, type: 'UNLOAD', address: 'VW Werk, 26723 Emden', city: 'Emden', latitude: 53.36, longitude: 7.2,
    arrivedAt: new Date('2026-11-04T17:40:00Z') } });
  for (const [login, role] of [['anna', 'dispatcher'], ['chef', 'admin']] as const) {
    ids[login] = (await db.dispatcher.create({ data: { login, displayName: login, role, passwordHash: hashDispatcherPassword(`${login} long password`) } })).id;
  }
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
beforeEach(async () => { ready = true; await db.dailyStatusReport.deleteMany(); });

const service = (startedAt?: Date) => new DailyStatusService(db as unknown as PostgresPrismaClient, deps(startedAt));

describe('07:00 schedule', () => {
  it('is not due before 07:00 Berlin, runs once at 07:00, then is done', async () => {
    const status = service();
    expect(await status.runIfDue(new Date('2026-11-05T05:59:59Z'))).toBe('NOT_DUE');
    expect(await status.runIfDue(new Date('2026-11-05T06:00:00Z'))).toBe('GENERATED');
    expect(await status.runIfDue(new Date('2026-11-05T06:00:15Z'))).toBe('DONE');
    const report = await db.dailyStatusReport.findFirstOrThrow();
    expect(report).toMatchObject({ line: 'SCHNELLECKE', date: '2026-11-05', status: 'READY', preliminary: false, generatedByRole: 'system' });
    expect(await db.auditLog.count({ where: { action: 'DAILY_STATUS_GENERATED', actorRole: 'system' } })).toBeGreaterThan(0);
  });
  it('two instances at the same moment make one list', async () => {
    const at = new Date('2026-11-05T06:00:00Z');
    const results = await Promise.all([service().runIfDue(at), service().runIfDue(at)]);
    expect(results.sort()).toEqual(['BUSY', 'GENERATED']);
    expect(await db.dailyStatusReport.count()).toBe(1);
  });
  it('waits for Webfleet up to 10 minutes after 07:00 or after a restart, then marks the list preliminary', async () => {
    ready = false;
    expect(await service().runIfDue(new Date('2026-11-05T06:05:00Z'))).toBe('WAITING_WEBFLEET');
    expect(await service(new Date('2026-11-05T08:00:00Z')).runIfDue(new Date('2026-11-05T08:05:00Z'))).toBe('WAITING_WEBFLEET');
    expect(await service().runIfDue(new Date('2026-11-05T06:10:00Z'))).toBe('GENERATED');
    expect((await db.dailyStatusReport.findFirstOrThrow()).preliminary).toBe(true);
  });
  it('follows Berlin time across the clock changes', async () => {
    // 29.03.2026 summer time (UTC+2): 07:00 = 05:00Z. 25.10.2026 winter time (UTC+1): 07:00 = 06:00Z.
    expect(await service().runIfDue(new Date('2026-03-29T04:59:00Z'))).toBe('NOT_DUE');
    expect(await service().runIfDue(new Date('2026-10-25T05:59:00Z'))).toBe('NOT_DUE');
    expect(await service(new Date('2026-03-29T00:00:00Z')).runIfDue(new Date('2026-03-29T05:00:00Z'))).toBe('GENERATED');
  });
  it('takes over a generation that hung for more than 5 minutes', async () => {
    await db.dailyStatusReport.create({ data: { line: 'SCHNELLECKE', date: '2026-11-05', status: 'GENERATING', generatedByRole: 'system', updatedAt: new Date('2026-11-05T06:00:00Z') } });
    expect(await service().runIfDue(new Date('2026-11-05T06:03:00Z'))).toBe('BUSY');
    expect(await service().runIfDue(new Date('2026-11-05T06:06:00Z'))).toBe('GENERATED');
  });
});

describe('list contents and edits', () => {
  const at = new Date('2026-11-05T06:00:00Z');
  it('only Schnellecke trucks, NORD → SÜD → without group, with the rules applied', async () => {
    const list = await service().generate('2026-11-05', at, { role: 'dispatcher', sessionId: 's', dispatcherId: ids.anna });
    expect(list.rows.map((row) => [row.vehicleNumber, row.statusGroup])).toEqual([['9724', 'NORD'], ['124', 'SUED'], ['777', null]]);
    expect(list.rows[0]).toMatchObject({ rule: 'STUCK', trailer: 'Z-S3280', shown: { ort: 'Emden', ziel: 'Emden', ankunft: '04.11. 18:40', bemerkung: 'Fahrzeug konnte gestern nicht entladen werden' } });
    expect(list.rows[1]).toMatchObject({ rule: 'EMPTY', servicePhone: '49 15904694508', appSped: true, shown: { ort: 'Ingolstadt', start: '', bemerkung: 'Fahrzeug ist leer' } });
  });
  it('a regenerated list keeps the dispatcher\'s Bemerkung and WE unless reset; a stale version gets 409', async () => {
    const first = await service().generate('2026-11-05', at, { role: 'dispatcher', sessionId: 's', dispatcherId: ids.anna });
    const row = first.rows.find((item) => item.vehicleNumber === '124')!;
    const edited = await service().editRow(row.id, { version: row.version, bemerkung: 'Fahrer hat frei', weNortheim: '08:30' }, { role: 'dispatcher', sessionId: 's', dispatcherId: ids.anna }, at);
    expect(edited).toMatchObject({ edited: true, shown: { bemerkung: 'Fahrer hat frei' }, weNortheim: '08:30' });
    await expect(service().editRow(row.id, { version: row.version, bemerkung: 'alt' }, { role: 'dispatcher', sessionId: 's' }, at)).rejects.toMatchObject({ statusCode: 409 });
    const again = await service().generate('2026-11-05', at, { role: 'dispatcher', sessionId: 's' });
    expect(again.rows.find((item) => item.vehicleNumber === '124')).toMatchObject({ bemerkung: 'Fahrer hat frei', weNortheim: '08:30' });
    const reset = await service().generate('2026-11-05', at, { role: 'dispatcher', sessionId: 's' }, { resetEdits: true });
    expect(reset.rows.find((item) => item.vehicleNumber === '124')).toMatchObject({ bemerkung: null, weNortheim: null, shown: { bemerkung: 'Fahrzeug ist leer' } });
    expect(await db.auditLog.count({ where: { action: 'DAILY_STATUS_ROW_EDITED', actorDispatcherId: ids.anna } })).toBe(1);
  });
  it('a past list is read only', async () => {
    await service().generate('2026-11-05', at, { role: 'system', sessionId: 'daily-status' });
    const next = new Date('2026-11-06T06:30:00Z');
    await expect(service().generate('2026-11-05', next, { role: 'dispatcher', sessionId: 's' })).rejects.toMatchObject({ statusCode: 409 });
    const row = (await service().get('2026-11-05', next)).rows[0]!;
    await expect(service().editRow(row.id, { version: row.version, bemerkung: 'x' }, { role: 'dispatcher', sessionId: 's' }, next)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('Excel in the dispatcher\'s layout', () => {
  it('blocks NORD, SÜD, LuFe with the header row, red truck numbers, ja green / nein red, text phone numbers, no empty extra block', async () => {
    const shown = (bemerkung: string) => ({ ort: 'Emden', start: '~06:45', ziel: 'Emden', ankunft: '06:08', bemerkung, trailer: '' });
    const buffer = await buildStatusWorkbook({ date: '2026-11-05', generatedAt: new Date('2026-11-05T06:00:00Z'), rows: [
      { vehicleNumber: '9724', statusGroup: 'NORD', weNortheim: null, servicePhone: '+49 1575 8235111', aSchild: false, appSped: true, shown: shown('=HYPERLINK("x")') },
      { vehicleNumber: '124', statusGroup: 'SUED', weNortheim: '08:30', servicePhone: null, aSchild: true, appSped: false, shown: shown('Fahrzeug ist leer') }
    ] });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.getWorksheet('Tabelle1')!;
    const values: string[][] = [];
    sheet.eachRow((row) => values.push((row.values as unknown[]).slice(1).map((value) => String(value ?? ''))));
    expect(values[0]![0]).toBe('Stand: 05.11.2026 07:00');
    const titles = values.filter((row) => ['NORD', 'SÜD', 'LuFe', 'Ohne Gruppe'].includes(row[0]!)).map((row) => row[0]);
    expect(titles).toEqual(['NORD', 'SÜD', 'LuFe']);
    expect((sheet.getRow(3).values as unknown[]).slice(1)).toEqual(['LKW', 'Ort', 'Start', 'Ziel', 'Ankunft', 'Bemerkung', 'Trailer', 'WE in Northeim', 'Telefon Nummer', 'A Schild', 'AppSped']);
    expect(sheet.getRow(4).getCell(1).value).toBe('NORD');
    const truck = sheet.getRow(5);
    expect(truck.getCell(1).value).toBe('9724');
    expect(truck.getCell(1).font?.color?.argb).toBe('FFC00000');
    expect(truck.getCell(6).value).toBe('=HYPERLINK("x")');
    expect(truck.getCell(6).formula).toBeUndefined();
    expect(truck.getCell(9).value).toBe('+49 1575 8235111');
    expect(truck.getCell(10).font?.color?.argb).toBe('FFC00000');
    expect(truck.getCell(11).font?.color?.argb).toBe('FF008000');
  });
});

describe('routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify();
    registerDispatcherAuth(app, db as never, { secret: 's'.repeat(32), origins: [ORIGIN] });
    registerDailyStatusRoutes(app, service());
    app.setErrorHandler((error, _request, reply) => {
      reply.status(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error instanceof Error ? error.message : 'error' });
    });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });
  const signIn = async (login: string) => {
    const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: ORIGIN }, payload: { login, password: `${login} long password` } });
    return { origin: ORIGIN, cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken };
  };

  it('needs a session, validates edits strictly and serves the Excel file with its name', async () => {
    expect((await app.inject({ method: 'GET', url: '/daily-status?date=2026-11-05' })).statusCode).toBe(401);
    const anna = await signIn('anna');
    expect((await app.inject({ method: 'GET', url: '/daily-status?date=05.11.2026', headers: anna })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/daily-status/2026-11-01/export.xlsx', headers: anna })).statusCode).toBe(404);
    await service().generate('2026-11-05', new Date('2026-11-05T06:00:00Z'), { role: 'system', sessionId: 'daily-status' });
    const row = (await service().get('2026-11-05', new Date('2026-11-05T06:00:00Z'))).rows[0]!;
    expect((await app.inject({ method: 'PATCH', url: `/daily-status/rows/${row.id}`, headers: anna, payload: { version: row.version, driverName: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/daily-status/rows/${row.id}`, headers: anna, payload: { version: row.version, bemerkung: 'x'.repeat(501) } })).statusCode).toBe(400);
    const file = await app.inject({ method: 'GET', url: '/daily-status/2026-11-05/export.xlsx', headers: anna });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('spreadsheetml');
    expect(file.headers['content-disposition']).toContain('filename="Status 2026-11-05.xlsx"');
    expect(file.headers['cache-control']).toBe('no-store');
  });
});
