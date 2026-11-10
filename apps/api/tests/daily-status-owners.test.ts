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
import { statusOwnerOf } from '../src/services/customers.js';
import { DailyStatusService, type DailyStatusDeps } from '../src/services/daily-status.js';
import { hashDispatcherPassword, registerDispatcherAuth } from '../src/services/dispatcher-auth.js';
import { EtaService } from '../src/services/eta.js';
import type { DriverHours } from '../src/services/webfleet-live.js';
import { migrateTestDatabase } from './test-database.js';

const ORIGIN = 'https://ops.test';
const DAY = '2026-11-10';
const AT = new Date('2026-11-10T06:00:00Z');
let directory: string;
let db: PrismaClient;
let app: FastifyInstance;
const ids: Record<string, string> = {};

const deps = (): DailyStatusDeps => ({
  getPosition: async () => ({ position: { latitude: 51.5, longitude: 9.9 }, positionSource: 'WEBFLEET', telemetryStale: false, remainingDistanceMeters: 0 } as CurrentPosition),
  latestTelemetry: async () => ({ address: 'Industriestraße 1, 37120 Bovenden', stale: false }),
  driverHours: async () => ({ status: 'NONE', workState: null, activitySince: null, times: null, timesStatus: 'NO_DATA' } as DriverHours),
  coupledTrailerNo: async () => null,
  webfleetReady: () => true,
  eta: new EtaService(),
  startedAt: new Date('2026-11-10T00:00:00Z')
});
const service = () => new DailyStatusService(db as unknown as PostgresPrismaClient, deps());
const actor = (login: string) => ({ role: (login === 'chef' ? 'admin' : 'dispatcher') as 'admin' | 'dispatcher', sessionId: `s-${login}`, dispatcherId: ids[login] });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-status-owners-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
  for (const [login, name, role, active] of [['anna', 'Anna Schmidt', 'dispatcher', true], ['ben', 'Ben Muster', 'dispatcher', true], ['chef', 'Chef', 'admin', true], ['gone', 'Gerd Alt', 'dispatcher', false]] as const) {
    ids[login] = (await db.dispatcher.create({ data: { login, displayName: name, role, active, passwordHash: hashDispatcherPassword(`${login} long password`) } })).id;
  }
  // Geis has lines but no daily list in its profile: its status is made by the button.
  const geis = await db.customer.create({ data: { name: 'Geis', slug: 'GEIS' } });
  for (const [code, sortIndex] of [['NORD', 0], ['SUED', 1], ['LUFE', 2]] as const) {
    ids[code] = (await db.customerLine.create({ data: { customerId: geis.id, code, name: code === 'SUED' ? 'Süd' : code === 'LUFE' ? 'LuFe' : 'Nord', sortIndex } })).id;
  }
  await db.dispatcherLine.createMany({ data: [
    { dispatcherId: ids.anna!, lineId: ids.NORD!, isPrimary: true },
    { dispatcherId: ids.anna!, lineId: ids.SUED!, isPrimary: false }, { dispatcherId: ids.ben!, lineId: ids.SUED!, isPrimary: true },
    { dispatcherId: ids.anna!, lineId: ids.LUFE!, isPrimary: false }, { dispatcherId: ids.ben!, lineId: ids.LUFE!, isPrimary: false },
    // A switched-off colleague on Nord does not make Anna's Nord trucks shared.
    { dispatcherId: ids.gone!, lineId: ids.NORD!, isPrimary: true }
  ] });
  const truck = (vehicleNumber: string, code: string, assignedDispatcherId: string | null = null) =>
    db.vehicle.create({ data: { vehicleNumber, line: 'GEIS', statusGroup: code, customerLineId: ids[code], assignedDispatcherId } }).then((vehicle) => { ids[vehicleNumber] = vehicle.id; });
  await truck('101', 'NORD');
  await truck('102', 'SUED');
  await truck('103', 'LUFE');
  await truck('104', 'LUFE', ids.ben);
  await truck('105', 'SUED', ids.gone);

  app = Fastify();
  registerDispatcherAuth(app, db as never, { secret: 's'.repeat(32), origins: [ORIGIN] });
  registerDailyStatusRoutes(app, service());
  app.setErrorHandler((error, _request, reply) => {
    reply.status(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error instanceof Error ? error.message : 'error' });
  });
  await app.ready();
}, 20_000);
afterAll(async () => { await app?.close(); await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
beforeEach(async () => {
  await db.dailyStatusReport.deleteMany();
  await db.vehicle.update({ where: { id: ids['103'] }, data: { assignedDispatcherId: null } });
});

const signIn = async (login: string) => {
  const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: ORIGIN }, payload: { login, password: `${login} long password` } });
  return { origin: ORIGIN, cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': response.json().csrfToken as string };
};
const owners = (rows: Array<{ vehicleNumber: string; owner: { name: string; source: string } | null }>) =>
  Object.fromEntries(rows.map((row) => [row.vehicleNumber, row.owner ? `${row.owner.name}/${row.owner.source}` : null]));
async function sheetText(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const values: string[] = [];
  workbook.getWorksheet('Tabelle1')!.eachRow((row) => values.push(String((row.values as unknown[])[1] ?? '')));
  return values;
}

describe('whose Excel a truck goes into', () => {
  it('taken → the taker; free → the only dispatcher of the line, else the only one whose main line it is, else nobody', () => {
    expect(statusOwnerOf({ assignedDispatcherId: 'a' }, [{ dispatcherId: 'b', isPrimary: true }])).toEqual({ id: 'a', source: 'TAKEN' });
    expect(statusOwnerOf({ assignedDispatcherId: null }, [{ dispatcherId: 'b', isPrimary: false }])).toEqual({ id: 'b', source: 'LINE' });
    expect(statusOwnerOf({ assignedDispatcherId: null }, [{ dispatcherId: 'a', isPrimary: false }, { dispatcherId: 'b', isPrimary: true }])).toEqual({ id: 'b', source: 'LINE' });
    expect(statusOwnerOf({ assignedDispatcherId: null }, [{ dispatcherId: 'a', isPrimary: true }, { dispatcherId: 'b', isPrimary: true }])).toBeNull();
    expect(statusOwnerOf({ assignedDispatcherId: null }, [{ dispatcherId: 'a', isPrimary: false }, { dispatcherId: 'b', isPrimary: false }])).toBeNull();
    expect(statusOwnerOf({ assignedDispatcherId: null }, [])).toBeNull();
  });
});

describe('status list of a customer without a daily list, by dispatcher', () => {
  it('is offered on the status page but never made at 07:00; the button makes it with the owner of every truck', async () => {
    const status = service();
    expect((await status.lists()).find((list) => list.key === 'GEIS')).toMatchObject({ auto: false, groups: [{ code: 'NORD' }, { code: 'SUED' }, { code: 'LUFE' }] });
    await status.runIfDue(AT);
    expect(await db.dailyStatusReport.count({ where: { line: 'GEIS' } })).toBe(0);

    const list = await status.generate(DAY, AT, actor('anna'), { list: 'GEIS' });
    expect(owners(list.rows)).toEqual({ '101': 'Anna Schmidt/LINE', '102': 'Ben Muster/LINE', '103': null, '104': 'Ben Muster/TAKEN', '105': 'Gerd Alt/TAKEN' });
    expect(list.rows.find((row) => row.vehicleNumber === '105')?.owner).toMatchObject({ active: false });
    expect(list.owners.map((owner) => [owner.name, owner.count])).toEqual([['Anna Schmidt', 1], ['Ben Muster', 2], ['Gerd Alt', 1]]);
    const stored = await db.dailyStatusRow.findFirstOrThrow({ where: { vehicleId: ids['104'] } });
    expect(JSON.parse(stored.detailsJson!)).toMatchObject({ owner: { id: ids.ben, source: 'TAKEN' } });
  });

  it('today a truck taken later moves at once; a past day keeps the owner of its morning', async () => {
    await service().generate(DAY, AT, actor('anna'), { list: 'GEIS' });
    await db.vehicle.update({ where: { id: ids['103'] }, data: { assignedDispatcherId: ids.anna } });
    expect(owners((await service().get(DAY, AT, 'GEIS')).rows)['103']).toBe('Anna Schmidt/TAKEN');
    expect(owners((await service().get(DAY, new Date('2026-11-11T06:30:00Z'), 'GEIS')).rows)['103']).toBeNull();
  });

  it('a dispatcher edits their own and nobody\'s trucks, not a colleague\'s; an admin edits all; the audit names the owner', async () => {
    const list = await service().generate(DAY, AT, actor('anna'), { list: 'GEIS' });
    const row = (number: string) => list.rows.find((item) => item.vehicleNumber === number)!;
    await expect(service().editRow(row('102').id, { version: row('102').version, bemerkung: 'x' }, actor('anna'), AT))
      .rejects.toMatchObject({ statusCode: 403, message: 'LKW 102 ведёт Ben Muster: Bemerkung правит этот диспетчер или администратор.' });
    expect(await service().editRow(row('101').id, { version: row('101').version, bemerkung: 'Fahrer hat frei' }, actor('anna'), AT)).toMatchObject({ owner: { id: ids.anna } });
    expect(await service().editRow(row('103').id, { version: row('103').version, weNortheim: '08:00' }, actor('anna'), AT)).toMatchObject({ owner: null });
    expect(await service().editRow(row('102').id, { version: row('102').version, bemerkung: 'Werkstatt' }, actor('chef'), AT)).toMatchObject({ bemerkung: 'Werkstatt' });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'DAILY_STATUS_ROW_EDITED', actorDispatcherId: ids.chef } });
    expect(JSON.parse(audit.metadataJson!)).toMatchObject({ vehicleNumber: '102', ownerId: ids.ben });
  });
});

describe('routes', () => {
  const excel = (headers: Record<string, string>, query = '') => app.inject({ method: 'GET', url: `/daily-status/${DAY}/export.xlsx?list=GEIS${query}`, headers });

  it('each dispatcher downloads only their own trucks; the whole list and other people\'s are for an admin', async () => {
    await service().generate(DAY, AT, actor('chef'), { list: 'GEIS' });
    const [anna, ben, chef] = await Promise.all([signIn('anna'), signIn('ben'), signIn('chef')]);

    expect((await excel(anna)).statusCode).toBe(403);
    expect((await excel(anna, `&owner=${ids.ben}`)).statusCode).toBe(403);
    expect((await excel(anna, '&owner=none')).statusCode).toBe(403);
    expect((await excel(anna, '&owner=x'.repeat(30))).statusCode).toBe(400);

    const annas = await excel(anna, '&owner=mine');
    expect(annas.statusCode).toBe(200);
    expect(annas.headers['content-disposition']).toContain('filename="Status Geis 2026-11-10.xlsx"');
    const annaSheet = await sheetText(annas.rawPayload);
    // Only Anna's truck, and only the block of its line.
    expect(annaSheet.filter((value) => /^\d{3}$/.test(value))).toEqual(['101']);
    expect(annaSheet.filter((value) => ['Nord', 'Süd', 'LuFe', 'Ohne Gruppe'].includes(value))).toEqual(['Nord']);
    expect((await sheetText((await excel(ben, `&owner=${ids.ben}`)).rawPayload)).filter((value) => /^\d{3}$/.test(value))).toEqual(['102', '104']);

    expect((await sheetText((await excel(chef)).rawPayload)).filter((value) => /^\d{3}$/.test(value))).toEqual(['101', '102', '105', '103', '104']);
    expect((await sheetText((await excel(chef, '&owner=none')).rawPayload)).filter((value) => /^\d{3}$/.test(value))).toEqual(['103']);
    const empty = await excel(chef, '&owner=mine');
    expect(empty.statusCode).toBe(404);
    expect(empty.json().error).toBe('У вас нет машин в статусе Geis за 10.11.');
  });

  it('tells the page who is looking', async () => {
    const anna = await signIn('anna');
    const response = await app.inject({ method: 'GET', url: `/daily-status?date=2026-11-01&list=GEIS`, headers: anna });
    expect(response.json()).toMatchObject({ viewer: { dispatcherId: ids.anna, role: 'dispatcher' }, owners: [], list: { key: 'GEIS', auto: false } });
  });
});
