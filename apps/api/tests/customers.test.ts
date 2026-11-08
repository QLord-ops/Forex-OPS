import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CurrentPosition } from '../src/domain.js';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { registerCustomerRoutes } from '../src/routes/customers.js';
import { mergeProfile, parseProfile, SCHNELLECKE_PROFILE } from '../src/services/customer-profile.js';
import { CustomerService, isMine, slugOf } from '../src/services/customers.js';
import { DailyStatusService } from '../src/services/daily-status.js';
import { buildStatusWorkbook } from '../src/services/daily-status-export.js';
import type { DispatcherRole } from '../src/services/dispatcher-auth.js';
import { EtaService } from '../src/services/eta.js';
import type { DriverHours } from '../src/services/webfleet-live.js';
import { migrateTestDatabase } from './test-database.js';
import ExcelJS from 'exceljs';

let directory: string;
let db: PrismaClient;
const admin = { role: 'admin' as const, sessionId: 's-admin' };
const app = () => db as unknown as PostgresPrismaClient;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-customers-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
});
afterEach(async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); });

async function legacyFleet() {
  await db.vehicle.create({ data: { vehicleNumber: '124', line: 'SCHNELLECKE', statusGroup: 'SUED' } });
  await db.vehicle.create({ data: { vehicleNumber: '9724', line: 'SCHNELLECKE', statusGroup: 'NORD' } });
  await db.vehicle.create({ data: { vehicleNumber: '777', line: 'SCHNELLECKE' } });
  await db.vehicle.create({ data: { vehicleNumber: '2853', line: 'WALTER_TESLA', statusGroup: 'SUED' } });
  await db.vehicle.create({ data: { vehicleNumber: '500', line: 'OTHER' } });
}

describe('customer profile', () => {
  it('fills every default, survives broken JSON and merges a patch section by section', () => {
    expect(parseProfile('not json')).toMatchObject({ version: 1, import: { routeSource: 'TOUR_REMARKS', dateOnlyMeansPlannedStart: true }, statusList: { enabled: false, dueLocalTime: '07:00' } });
    const merged = mergeProfile(SCHNELLECKE_PROFILE, { statusList: { dueLocalTime: '06:30' } });
    expect(merged.statusList).toMatchObject({ enabled: true, dueLocalTime: '06:30', excludedVehicles: ['727', '2853'], weColumnLabel: 'WE in Northeim' });
    expect(merged.import.warehouseWords).toContain('Lager');
    expect(() => mergeProfile(SCHNELLECKE_PROFILE, { statusList: { dueLocalTime: '7 Uhr' } })).toThrow();
  });
  it('counts as «Мои» my own trucks and free trucks on my lines, never a colleague\'s', () => {
    const lines = new Set(['nord']);
    expect(isMine('anna', { assignedDispatcherId: 'anna', customerLineId: null }, lines)).toBe(true);
    expect(isMine('anna', { assignedDispatcherId: null, customerLineId: 'nord' }, lines)).toBe(true);
    expect(isMine('anna', { assignedDispatcherId: 'ben', customerLineId: 'nord' }, lines)).toBe(false);
    expect(isMine('anna', { assignedDispatcherId: null, customerLineId: 'sued' }, lines)).toBe(false);
    expect(isMine(null, { assignedDispatcherId: null, customerLineId: 'nord' }, lines)).toBe(false);
  });
  it('makes stable keys from names', () => {
    expect(slugOf('Walter (Tesla)')).toBe('WALTER_TESLA');
    expect(slugOf('Groß & Söhne')).toBe('GROSS_SOHNE');
  });
});

describe('CustomerService', () => {
  it('creates customers and lines once each and archives instead of deleting', async () => {
    const service = new CustomerService(app());
    const customer = await service.create({ name: 'Nordwerk Logistik', category: 'OEM_LOGISTICS', aliases: ['Nordwerk', 'NW'] }, admin);
    expect(customer.slug).toBe('NORDWERK_LOGISTIK');
    await expect(service.create({ name: 'Nordwerk Logistik' }, admin)).rejects.toMatchObject({ statusCode: 409 });
    const line = await service.addLine(customer.id, { code: 'kassel', name: 'Kassel' }, admin);
    expect(line.code).toBe('KASSEL');
    await expect(service.addLine(customer.id, { code: 'KASSEL', name: 'Doppelt' }, admin)).rejects.toMatchObject({ statusCode: 409 });
    await service.update(customer.id, { active: false }, admin);
    const listed = await service.list();
    expect(listed[0]).toMatchObject({ name: 'Nordwerk Logistik', active: false, aliases: ['Nordwerk', 'NW'], lines: [{ code: 'KASSEL', vehicleCount: 0 }] });
    expect(await db.auditLog.count({ where: { action: { in: ['CUSTOMER_CREATED', 'CUSTOMER_LINE_CREATED', 'CUSTOMER_ARCHIVED'] } } })).toBe(3);
  });

  it('puts a truck on a line and keeps the status-list strings in step', async () => {
    const service = new CustomerService(app());
    const customer = await service.create({ name: 'Walter (Tesla)' }, admin);
    const line = await service.addLine(customer.id, { code: 'TESLA', name: 'Tesla' }, admin);
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: '321' } });
    expect(await service.setVehicleLine(vehicle.id, line.id, admin)).toMatchObject({ customerLineId: line.id, line: 'WALTER_TESLA', statusGroup: 'TESLA' });
    expect(await service.setVehicleLine(vehicle.id, null, admin)).toMatchObject({ customerLineId: null, line: null, statusGroup: null });
    await service.updateLine(line.id, { active: false }, admin);
    await expect(service.setVehicleLine(vehicle.id, line.id, admin)).rejects.toMatchObject({ statusCode: 404 });
    expect(await db.auditLog.count({ where: { action: 'VEHICLE_LINE_SET' } })).toBe(2);
  });

  it('gives a dispatcher lines with one primary and lets them edit only their own customers', async () => {
    const service = new CustomerService(app());
    const a = await service.create({ name: 'Schnellecke' }, admin);
    const b = await service.create({ name: 'Walter (Tesla)' }, admin);
    const nord = await service.addLine(a.id, { code: 'NORD', name: 'Nord' }, admin);
    const sued = await service.addLine(a.id, { code: 'SUED', name: 'Süd' }, admin);
    const anna = await db.dispatcher.create({ data: { login: 'anna', displayName: 'Anna', passwordHash: 'x' } });
    const lines = await service.setDispatcherLines(anna.id, [nord.id, sued.id], sued.id, admin);
    expect(lines.map((row) => [row.line.code, row.isPrimary]).sort()).toEqual([['NORD', false], ['SUED', true]]);
    await expect(service.setDispatcherLines(anna.id, [nord.id], sued.id, admin)).rejects.toMatchObject({ statusCode: 400 });
    expect(await service.linesOf(anna.id)).toHaveLength(2);
    const actor = { role: 'dispatcher' as const, sessionId: 's', dispatcherId: anna.id };
    expect(await service.canEditProfile(actor, a.id)).toBe(true);
    expect(await service.canEditProfile(actor, b.id)).toBe(false);
    expect(await service.canEditProfile({ role: 'dispatcher', sessionId: 's' }, a.id)).toBe(false);
  });

  it('previews and then creates Schnellecke and Walter from the trucks\' line strings, safely twice', async () => {
    await legacyFleet();
    const service = new CustomerService(app());
    const preview = await service.migrationPreview();
    expect(preview).toEqual([
      { slug: 'SCHNELLECKE', name: 'Schnellecke', exists: false, statusList: true, lines: [
        { code: 'NORD', name: 'Nord', vehicles: ['9724'] }, { code: 'SUED', name: 'Süd', vehicles: ['124'] }, { code: 'ALLGEMEIN', name: 'Allgemein', vehicles: ['777'] }] },
      { slug: 'WALTER_TESLA', name: 'Walter (Tesla)', exists: false, statusList: false, lines: [{ code: 'TESLA', name: 'Tesla', vehicles: ['2853'] }] }
    ]);
    expect(await db.customer.count()).toBe(0);
    const result = await service.migrateFromLines(admin);
    expect(result).toEqual([{ slug: 'SCHNELLECKE', created: true, lines: 3, vehicles: 3 }, { slug: 'WALTER_TESLA', created: true, lines: 1, vehicles: 1 }]);
    const nine = await db.vehicle.findUniqueOrThrow({ where: { vehicleNumber: '9724' }, include: { customerLine: { include: { customer: true } } } });
    expect(nine).toMatchObject({ line: 'SCHNELLECKE', statusGroup: 'NORD', customerLine: { code: 'NORD', customer: { slug: 'SCHNELLECKE' } } });
    expect(parseProfile((await db.customer.findUniqueOrThrow({ where: { slug: 'SCHNELLECKE' } })).profileJson).statusList.excludedVehicles).toEqual(['727', '2853']);
    expect(await db.vehicle.findUniqueOrThrow({ where: { vehicleNumber: '500' } })).toMatchObject({ customerLineId: null, line: 'OTHER' });
    expect(await service.migrationPreview()).toEqual([]);
    expect(await service.migrateFromLines(admin)).toEqual([]);
    expect(await db.customer.count()).toBe(2);
  });

  it('shows what was gathered about a customer: trucks, tours through the truck\'s line, Auftrag and corrections', async () => {
    await legacyFleet();
    const service = new CustomerService(app());
    await service.migrateFromLines(admin);
    const schnellecke = await db.customer.findUniqueOrThrow({ where: { slug: 'SCHNELLECKE' } });
    const truck = await db.vehicle.findUniqueOrThrow({ where: { vehicleNumber: '124' } });
    await db.tour.create({ data: { vehicleId: truck.id, orderNumber: 'A-1', status: 'ACTIVE' } });
    const document = await db.orderDocument.create({ data: { sha256: 'e'.repeat(64), filename: 'a.pdf', mimeType: 'application/pdf', size: 1, content: Buffer.from('a'), previewJson: '{}', status: 'ATTACHED', customerId: schnellecke.id }, select: { id: true } });
    await db.importCorrection.create({ data: { documentId: document.id, kind: 'FIELD_CHANGED', field: 'company', signature: 's1', customerId: schnellecke.id } });
    const detail = await service.get(schnellecke.id, new Date());
    expect(detail.overview).toMatchObject({ vehicles: 3, activeTours: 1, tours30d: 1, documents: 1, documentsWithoutCorrections: 0, mostCorrected: [{ field: 'company', count: 1 }], learnedRules: 0 });
    expect(detail.overview.recentDocuments).toHaveLength(1);
  });
});

describe('status lists per customer', () => {
  const deps = () => ({
    getPosition: async () => ({ position: { latitude: 52.4, longitude: 9.7 }, positionSource: 'WEBFLEET', telemetryStale: false, remainingDistanceMeters: 0 } as CurrentPosition),
    latestTelemetry: async () => ({ address: 'A7, Hannover', stale: false }),
    driverHours: async () => ({ status: 'NONE', workState: null, activitySince: null, times: null, timesStatus: 'NO_DATA' } as DriverHours),
    coupledTrailerNo: async () => null, webfleetReady: () => true, eta: new EtaService(), startedAt: new Date('2026-11-09T00:00:00Z')
  });

  it('keeps the original Schnellecke list until Schnellecke is a customer, then uses its lines, columns and exclusions', async () => {
    await legacyFleet();
    await db.vehicle.create({ data: { vehicleNumber: '727', line: 'SCHNELLECKE', statusGroup: 'NORD' } });
    const before = new DailyStatusService(app(), deps());
    expect((await before.lists()).map((list) => list.key)).toEqual(['SCHNELLECKE']);
    expect((await before.list()).groups.map((group) => group.name)).toEqual(['NORD', 'SÜD', 'LuFe']);

    await new CustomerService(app()).migrateFromLines(admin);
    const after = new DailyStatusService(app(), deps());
    const lists = await after.lists();
    expect(lists.map((list) => [list.key, list.dueLocalTime])).toEqual([['SCHNELLECKE', '07:00']]);
    expect(lists[0].groups.map((group) => group.code)).toEqual(['NORD', 'SUED', 'ALLGEMEIN']);

    const at = new Date('2026-11-09T06:00:00Z');
    expect(await after.runIfDue(at)).toBe('GENERATED');
    const list = await after.get('2026-11-09', at);
    expect(list.list).toMatchObject({ key: 'SCHNELLECKE', name: 'Schnellecke', columns: { we: 'WE in Northeim', aSchild: true, appSped: true } });
    // 727 is on a Schnellecke line but excluded by the profile; Walter's 2853 has its own customer without a list.
    expect(list.rows.map((row) => row.vehicleNumber).sort()).toEqual(['124', '777', '9724']);
    expect((await db.dailyStatusReport.findFirstOrThrow()).customerId).toBe(lists[0].customerId);
    await expect(after.get('2026-11-09', at, 'WALTER_TESLA')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('builds a second customer\'s list at its own time and with its own columns', async () => {
    const customers = new CustomerService(app());
    const walter = await customers.create({ name: 'Walter (Tesla)', profile: { statusList: { enabled: true, dueLocalTime: '08:30', weColumnLabel: null, showASchild: false, showAppSped: false } } }, admin);
    const line = await customers.addLine(walter.id, { code: 'TESLA', name: 'Tesla Grünheide' }, admin);
    const truck = await db.vehicle.create({ data: { vehicleNumber: '2853' } });
    await customers.setVehicleLine(truck.id, line.id, admin);
    const status = new DailyStatusService(app(), deps());
    expect((await status.lists()).map((list) => list.key)).toEqual(['SCHNELLECKE', 'WALTER_TESLA']);
    // 07:00 Berlin: Schnellecke (no trucks) is generated, Walter is not due until 08:30.
    await status.runIfDue(new Date('2026-11-09T06:00:00Z'));
    expect((await status.get('2026-11-09', new Date('2026-11-09T06:00:00Z'), 'WALTER_TESLA')).report).toBeNull();
    await status.runIfDue(new Date('2026-11-09T07:30:00Z'));
    const list = await status.get('2026-11-09', new Date('2026-11-09T07:30:00Z'), 'WALTER_TESLA');
    expect(list.rows.map((row) => [row.vehicleNumber, row.statusGroup])).toEqual([['2853', 'TESLA']]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildStatusWorkbook({ date: '2026-11-09', generatedAt: null, rows: list.rows, groups: list.list.groups, columns: list.list.columns }) as never);
    const header = workbook.getWorksheet('Tabelle1')!.getRow(3).values as unknown[];
    expect(header.filter(Boolean)).toEqual(['LKW', 'Ort', 'Start', 'Ziel', 'Ankunft', 'Bemerkung', 'Trailer', 'Telefon Nummer']);
    expect(workbook.getWorksheet('Tabelle1')!.getRow(4).getCell(1).value).toBe('Tesla Grünheide');
  });
});

describe('customer routes', () => {
  async function build(role: DispatcherRole, dispatcherId: string | null = null) {
    const server = Fastify();
    server.addHook('onRequest', async (request) => {
      request.dispatcherSession = { token: 't', expiresAt: Number.MAX_SAFE_INTEGER, role, sessionId: 's', dispatcherId, displayName: 'x' };
    });
    registerCustomerRoutes(server, new CustomerService(app()));
    server.setErrorHandler((error, _request, reply) => { reply.status(error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as Error).message }); });
    return server;
  }

  it('lets admins manage customers and lines, dispatchers tune their own customer\'s profile and put trucks on lines', async () => {
    const chef = await build('admin');
    const created = await chef.inject({ method: 'POST', url: '/customers', payload: { name: 'Schnellecke', category: 'OEM_LOGISTICS' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const line = (await chef.inject({ method: 'POST', url: `/customers/${id}/lines`, payload: { code: 'NORD', name: 'Nord' } })).json();
    const anna = await db.dispatcher.create({ data: { login: 'anna', displayName: 'Anna', passwordHash: 'x' } });
    expect((await chef.inject({ method: 'PUT', url: `/dispatchers/${anna.id}/lines`, payload: { lineIds: [line.id] } })).statusCode).toBe(200);

    const dispatcher = await build('dispatcher', anna.id);
    expect((await dispatcher.inject({ method: 'POST', url: '/customers', payload: { name: 'Neu' } })).statusCode).toBe(403);
    expect((await dispatcher.inject({ method: 'PATCH', url: `/customers/${id}`, payload: { name: 'Umbenannt' } })).statusCode).toBe(403);
    const patched = await dispatcher.inject({ method: 'PATCH', url: `/customers/${id}`, payload: { profile: { import: { aiNotes: 'Abteilung ist immer Ludwigsfelde' } } } });
    expect(patched.statusCode).toBe(200);
    expect(parseProfile(patched.json().profileJson).import.aiNotes).toBe('Abteilung ist immer Ludwigsfelde');
    const other = await build('dispatcher', 'someone-else');
    expect((await other.inject({ method: 'PATCH', url: `/customers/${id}`, payload: { profile: { import: { aiNotes: 'x' } } } })).statusCode).toBe(403);

    const truck = await db.vehicle.create({ data: { vehicleNumber: '321' } });
    expect((await dispatcher.inject({ method: 'PUT', url: `/vehicles/${truck.id}/customer-line`, payload: { lineId: line.id } })).json()).toMatchObject({ line: 'SCHNELLECKE', statusGroup: 'NORD' });
    expect((await dispatcher.inject({ method: 'GET', url: '/customers' })).json().customers[0]).toMatchObject({ name: 'Schnellecke', lines: [{ code: 'NORD', vehicleCount: 1, dispatchers: [{ name: 'Anna', primary: true }] }] });
    expect((await dispatcher.inject({ method: 'GET', url: '/customers/migration-preview' })).statusCode).toBe(403);
    expect((await chef.inject({ method: 'GET', url: '/customers/migration-preview' })).json()).toEqual({ customers: [] });
    expect((await chef.inject({ method: 'PATCH', url: `/customers/${id}`, payload: { color: 'blue' } })).statusCode).toBe(400);
  });
});
