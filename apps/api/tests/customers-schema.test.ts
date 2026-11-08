import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-customers-schema-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

it('keeps customers with their lines, one code per customer, and empty profiles by default', async () => {
  const schnellecke = await db.customer.create({ data: { name: 'Schnellecke', slug: 'SCHNELLECKE', category: 'OEM_LOGISTICS' } });
  expect(schnellecke).toMatchObject({ active: true, aliasesJson: '[]', profileJson: '{}', color: null });
  await expect(db.customer.create({ data: { name: 'Doppelt', slug: 'SCHNELLECKE' } })).rejects.toThrow();
  const walter = await db.customer.create({ data: { name: 'Walter (Tesla)', slug: 'WALTER_TESLA' } });
  expect(walter.category).toBe('OTHER');

  const nord = await db.customerLine.create({ data: { customerId: schnellecke.id, code: 'NORD', name: 'Nord', sortIndex: 1 } });
  await expect(db.customerLine.create({ data: { customerId: schnellecke.id, code: 'NORD', name: 'Nord 2' } })).rejects.toThrow();
  await expect(db.customerLine.create({ data: { customerId: walter.id, code: 'NORD', name: 'Nord' } })).resolves.toBeTruthy();
  expect(await db.customer.findUnique({ where: { id: schnellecke.id }, include: { lines: true } })).toMatchObject({ lines: [{ id: nord.id, active: true, departmentAddress: null }] });
});

it('links trucks, tours and dispatchers to lines and lets a line go without losing them', async () => {
  const customer = await db.customer.create({ data: { name: 'Kunde', slug: 'KUNDE' } });
  const line = await db.customerLine.create({ data: { customerId: customer.id, code: 'LUFE', name: 'LuFe' } });
  const dispatcher = await db.dispatcher.create({ data: { login: 'anna', displayName: 'Anna', passwordHash: 'x', locale: 'de' } });
  await db.dispatcherLine.create({ data: { dispatcherId: dispatcher.id, lineId: line.id, isPrimary: true } });
  await expect(db.dispatcherLine.create({ data: { dispatcherId: dispatcher.id, lineId: line.id } })).rejects.toThrow();
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: '321', maxSpeedKmh: 85, customerLineId: line.id } });
  const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: '71123727', status: 'PLANNED', customerId: customer.id, customerLineId: line.id } });
  expect(await db.dispatcher.findUnique({ where: { id: dispatcher.id }, include: { lines: { include: { line: true } } } })).toMatchObject({ locale: 'de', lines: [{ isPrimary: true, line: { code: 'LUFE' } }] });

  await db.customerLine.delete({ where: { id: line.id } });
  expect(await db.vehicle.findUnique({ where: { id: vehicle.id } })).toMatchObject({ customerLineId: null });
  expect(await db.tour.findUnique({ where: { id: tour.id } })).toMatchObject({ customerId: customer.id, customerLineId: null });
  expect(await db.dispatcherLine.count({ where: { dispatcherId: dispatcher.id } })).toBe(0);
});

it('scopes import rules: the same pattern may be learned globally and per customer, once each', async () => {
  await db.importRule.create({ data: { kind: 'ALIAS', pattern: 'nw', value: 'Nordwerk AG' } });
  expect((await db.importRule.findFirstOrThrow({ where: { pattern: 'nw' } })).scope).toBe('global');
  await expect(db.importRule.create({ data: { kind: 'ALIAS', pattern: 'nw', value: 'Anders' } })).rejects.toThrow();
  await expect(db.importRule.create({ data: { scope: 'cust-1', kind: 'ALIAS', pattern: 'nw', value: 'Nordwerk Kassel' } })).resolves.toBeTruthy();
  expect(await db.importRule.findUnique({ where: { scope_kind_pattern: { scope: 'cust-1', kind: 'ALIAS', pattern: 'nw' } } })).toMatchObject({ value: 'Nordwerk Kassel' });
});

it('stores the customer of a document and a correction, translation parameters and the list customer', async () => {
  const document = await db.orderDocument.create({ data: { sha256: 'd'.repeat(64), filename: 'a.pdf', mimeType: 'application/pdf', size: 1, content: Buffer.from('a'), previewJson: '{}', customerId: 'cust-1' }, select: { id: true, customerId: true } });
  expect(document.customerId).toBe('cust-1');
  const correction = await db.importCorrection.create({ data: { documentId: document.id, kind: 'STOP_REMOVED', signature: 's', customerId: 'cust-1' } });
  expect(correction.customerId).toBe('cust-1');
  const notification = await db.notification.create({ data: { dedupKey: 'k', vehicleId: 'v', type: 'AUTO_ARRIVAL', message: 'Прибытие по GPS', payloadJson: '{}', paramsJson: '{"vehicle":"321"}' } });
  expect(notification.paramsJson).toBe('{"vehicle":"321"}');
  const report = await db.dailyStatusReport.create({ data: { line: 'SCHNELLECKE', date: '2026-11-09', generatedByRole: 'system', customerId: 'cust-1' } });
  expect(report.customerId).toBe('cust-1');
});
