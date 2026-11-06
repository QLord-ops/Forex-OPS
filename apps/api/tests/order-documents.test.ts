import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { OrderDocumentService, readDocumentOptions, sha256Of } from '../src/services/order-documents.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

let directory: string;
let db: PrismaClient;
const actor = { role: 'dispatcher' as const, sessionId: 's1', dispatcherId: 'd1' };
const pdf = Buffer.from('%PDF-1.7 Transportauftrag 71123727');

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-order-documents-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
});
afterEach(async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); });

async function tour(orderNumber: string) {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: `V-${orderNumber}`, maxSpeedKmh: 85 } });
  return db.tour.create({ data: { vehicleId: vehicle.id, orderNumber, status: 'PLANNED' } });
}

it('stores a file once per hash and refreshes the parse of a still-pending upload', async () => {
  const service = new OrderDocumentService(asAppDatabase(db));
  const first = await service.store({ buffer: pdf, filename: 'Transportauftrag (002).pdf', mimeType: 'application/pdf', previewJson: { drafts: [{ orderNumber: '1' }] }, actor });
  expect(first).toMatchObject({ reused: false, attachedTourId: null, sha256: sha256Of(pdf) });
  const second = await service.store({ buffer: pdf, filename: 'again.pdf', mimeType: 'application/pdf', previewJson: { drafts: [{ orderNumber: '2' }] }, actor });
  expect(second).toMatchObject({ id: first.id, reused: true });
  const stored = await service.get(first.id);
  expect(stored).toMatchObject({ filename: 'again.pdf', status: 'PENDING', uploadedByDispatcherId: 'd1', size: pdf.length });
  expect(JSON.parse(stored!.previewJson)).toEqual({ drafts: [{ orderNumber: '2' }] });
  expect(await db.orderDocument.count()).toBe(1);
});

it('attaches a document to its tour once and refuses a second tour', async () => {
  const service = new OrderDocumentService(asAppDatabase(db));
  const { id } = await service.store({ buffer: pdf, filename: 'a.pdf', mimeType: 'application/pdf', previewJson: {}, actor });
  const first = await tour('71123727');
  const attached = await service.attach({ documentId: id, tourId: first.id, vehicleId: first.vehicleId, confirmedJson: { stops: [] }, actor });
  expect(attached).toMatchObject({ status: 'ATTACHED', tourId: first.id, vehicleId: first.vehicleId });
  expect(await service.attach({ documentId: id, tourId: first.id, vehicleId: first.vehicleId, confirmedJson: {}, actor })).toMatchObject({ tourId: first.id });
  const other = await tour('71123728');
  await expect(service.attach({ documentId: id, tourId: other.id, vehicleId: other.vehicleId, confirmedJson: {}, actor })).rejects.toMatchObject({ statusCode: 409 });
  // The same file uploaded again now tells which tour owns it.
  expect(await service.store({ buffer: pdf, filename: 'a.pdf', mimeType: 'application/pdf', previewJson: {}, actor })).toMatchObject({ reused: true, attachedTourId: first.id });
  expect(await service.forTour(first.id)).toMatchObject({ id, filename: 'a.pdf' });
  expect((await service.listForVehicle(first.vehicleId)).map((row) => row.id)).toEqual([id]);
  expect(await db.auditLog.count({ where: { action: 'ORDER_DOCUMENT_ATTACHED', tourId: first.id } })).toBe(1);
  expect(await service.attach({ documentId: 'missing', tourId: first.id, vehicleId: first.vehicleId, confirmedJson: {}, actor })).toBeNull();
});

it('serves the bytes only through file() and keeps them out of the metadata reads', async () => {
  const service = new OrderDocumentService(asAppDatabase(db));
  const { id } = await service.store({ buffer: pdf, filename: 'a.pdf', mimeType: 'application/pdf', previewJson: {}, actor });
  const file = await service.file(id);
  expect(file?.content.equals(pdf)).toBe(true);
  expect(file).toMatchObject({ filename: 'a.pdf', mimeType: 'application/pdf', size: pdf.length });
  expect(await service.get(id)).not.toHaveProperty('content');
  expect(await service.file('missing')).toBeNull();
});

it('purges unattached uploads after the TTL and empties old attached files but keeps their rows', async () => {
  const service = new OrderDocumentService(asAppDatabase(db), { pendingTtlDays: 7, retentionDays: 30 });
  const day = 24 * 3600_000;
  const now = new Date('2026-11-06T12:00:00Z');
  const stale = await service.store({ buffer: Buffer.from('old pending'), filename: 'p.pdf', mimeType: 'application/pdf', previewJson: {}, actor });
  await db.orderDocument.update({ where: { id: stale.id }, data: { createdAt: new Date(now.getTime() - 8 * day) } });
  const fresh = await service.store({ buffer: Buffer.from('fresh pending'), filename: 'f.pdf', mimeType: 'application/pdf', previewJson: {}, actor });
  const attachedOld = await service.store({ buffer: Buffer.from('attached old'), filename: 'o.pdf', mimeType: 'application/pdf', previewJson: { drafts: [] }, actor });
  const oldTour = await tour('1');
  await service.attach({ documentId: attachedOld.id, tourId: oldTour.id, vehicleId: oldTour.vehicleId, confirmedJson: {}, actor }, new Date(now.getTime() - 40 * day));
  const attachedNew = await service.store({ buffer: Buffer.from('attached new'), filename: 'n.pdf', mimeType: 'application/pdf', previewJson: {}, actor });
  const newTour = await tour('2');
  await service.attach({ documentId: attachedNew.id, tourId: newTour.id, vehicleId: newTour.vehicleId, confirmedJson: {}, actor }, new Date(now.getTime() - 2 * day));

  expect(await service.purge(now, { role: 'system', sessionId: 'sweep' })).toEqual({ pending: 1, emptied: 1 });
  expect(await service.get(stale.id)).toBeNull();
  expect(await service.get(fresh.id)).toMatchObject({ status: 'PENDING' });
  expect(await service.file(attachedOld.id)).toBeNull();
  expect(await service.get(attachedOld.id)).toMatchObject({ status: 'ATTACHED', tourId: oldTour.id, size: 0 });
  expect(JSON.parse((await service.get(attachedOld.id))!.previewJson)).toEqual({ drafts: [] });
  expect((await service.file(attachedNew.id))?.content.toString()).toBe('attached new');
  expect(await service.purge(now, { role: 'system', sessionId: 'sweep' })).toEqual({ pending: 0, emptied: 0 });
  expect(await db.auditLog.count({ where: { action: 'ORDER_DOCUMENTS_PURGED' } })).toBe(1);
});

it('discards only pending documents and reads retention from the environment', async () => {
  const service = new OrderDocumentService(asAppDatabase(db));
  const pending = await service.store({ buffer: Buffer.from('x'), filename: 'x.pdf', mimeType: 'application/pdf', previewJson: {}, actor });
  const kept = await service.store({ buffer: Buffer.from('y'), filename: 'y.pdf', mimeType: 'application/pdf', previewJson: {}, actor });
  const owner = await tour('3');
  await service.attach({ documentId: kept.id, tourId: owner.id, vehicleId: owner.vehicleId, confirmedJson: {}, actor });
  expect(await service.discard(pending.id, actor)).toBe(true);
  expect(await service.discard(kept.id, actor)).toBe(false);
  expect(await db.auditLog.count({ where: { action: 'ORDER_DOCUMENT_DELETED' } })).toBe(1);
  expect(readDocumentOptions({ ORDER_DOCUMENT_PENDING_TTL_DAYS: '3', ORDER_DOCUMENT_RETENTION_DAYS: 'soon' })).toEqual({ pendingTtlDays: 3, retentionDays: 365 });
});
