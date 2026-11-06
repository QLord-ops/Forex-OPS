import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-order-document-schema-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

it('keeps one Auftrag per file hash and per tour, pending by default, with its bytes outside the usual select', async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: '321', maxSpeedKmh: 85 } });
  const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: '71123727', status: 'PLANNED' } });
  const content = Buffer.from('%PDF-1.7 test');
  const document = await db.orderDocument.create({
    data: { sha256: 'a'.repeat(64), filename: 'Transportauftrag.pdf', mimeType: 'application/pdf', size: content.length, content, previewJson: '{"drafts":[]}' },
    select: { id: true, status: true, tourId: true, confirmedJson: true }
  });
  expect(document).toMatchObject({ status: 'PENDING', tourId: null, confirmedJson: null });
  await expect(db.orderDocument.create({ data: { sha256: 'a'.repeat(64), filename: 'x.pdf', mimeType: 'application/pdf', size: 1, content, previewJson: '{}' } })).rejects.toThrow();

  await db.orderDocument.update({ where: { id: document.id }, data: { tourId: tour.id, status: 'ATTACHED', attachedAt: new Date() } });
  const stored = await db.orderDocument.findUnique({ where: { id: document.id } });
  expect(Buffer.from(stored!.content).equals(content)).toBe(true);
  expect(await db.tour.findUnique({ where: { id: tour.id }, include: { document: { select: { id: true, filename: true } } } })).toMatchObject({ document: { id: document.id, filename: 'Transportauftrag.pdf' } });
  await expect(db.orderDocument.create({ data: { sha256: 'b'.repeat(64), filename: 'y.pdf', mimeType: 'application/pdf', size: 1, content, previewJson: '{}', tourId: tour.id } })).rejects.toThrow();
});

it('counts corrections per document and keeps one rule per kind and pattern', async () => {
  const content = Buffer.from('xlsx');
  const document = await db.orderDocument.create({ data: { sha256: 'c'.repeat(64), filename: 'a.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4, content, previewJson: '{}' }, select: { id: true } });
  await db.importCorrection.create({ data: { documentId: document.id, kind: 'STOP_REMOVED', signature: 'STOP_REMOVED::lg:', contextJson: '{"tourRemarksLabel":"LG"}' } });
  expect(await db.importCorrection.count({ where: { documentId: document.id } })).toBe(1);

  const rule = await db.importRule.create({ data: { kind: 'IGNORE_LABEL', pattern: 'lg', hits: 1 } });
  expect(rule).toMatchObject({ active: false, applied: 0, builtIn: false, value: null });
  await expect(db.importRule.create({ data: { kind: 'IGNORE_LABEL', pattern: 'lg' } })).rejects.toThrow();
  await expect(db.importRule.create({ data: { kind: 'ALIAS', pattern: 'lg', value: 'LG Electronics' } })).resolves.toBeTruthy();

  const dispatcher = await db.dispatcher.create({ data: { login: 'neu', displayName: 'Neu', passwordHash: 'x' } });
  expect(dispatcher.onboardingCompletedAt).toBeNull();
});
