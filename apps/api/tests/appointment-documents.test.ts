import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient as PostgresPrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { berlinLocalToDate, matchAppointment } from '../src/services/appointment-match.js';
import { AppointmentService } from '../src/services/appointments.js';
import { importPdfPreview, isTerminSlipText, type AppointmentDocument } from '../src/services/pdf-order-import.js';
import { deckblattPdf } from './pdf-fixture.js';
import { documentFingerprint, PendingAppointmentService } from '../src/services/pending-appointments.js';
import { migrateTestDatabase } from './test-database.js';

let db: PrismaClient;
let directory: string;
const pg = () => db as unknown as PostgresPrismaClient;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ops-termin-'));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
  await migrateTestDatabase(db);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const blank = { documentType: null, plate: null, trailerPlate: null, company: null, site: null, city: null, stopType: null, appointmentLocal: null, windowStartLocal: null,
  windowEndLocal: null, appointmentDateLocal: null, standgeldFromLocal: null, references: [], positions: [], sourceExcerpt: null, confidence: 0.9 };

async function recognise(appointment: Record<string, unknown>) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({ documentKind: 'APPOINTMENT', drafts: [], appointment: { ...blank, ...appointment }, warnings: [] }) })));
  return importPdfPreview(Buffer.from('%PDF-1.4'), 'termin.pdf', { apiKey: 'test-key', fetchImpl, now: new Date('2026-11-03T12:00:00Z') });
}

describe('recognising Termin slips (synthetic copies of the dispatcher examples)', () => {
  it('reads a Fahrtenschein: exact planned arrival, truck plate, plant and references', async () => {
    const preview = await recognise({ documentType: 'LKWcontrol Fahrtenschein', plate: 'GÖ-FX900', company: 'MAN Truck & Bus SE München', city: 'München', stopType: 'UNLOAD',
      appointmentLocal: '2026-11-04T11:00', references: [{ label: 'Fahrt-ID', value: 'T00000000000001' }], positions: ['A36 Entladung 4 LE'] });
    expect(preview.documentKind).toBe('APPOINTMENT');
    expect(preview.drafts).toEqual([]);
    expect(preview.appointment).toMatchObject({ kind: 'VW_FAHRTENSCHEIN', plate: 'GÖ-FX900', company: 'MAN Truck & Bus SE München', appointmentLocal: '2026-11-04T11:00', windowStartLocal: null });
  });

  it('turns Von/Bis and a latest arrival into a window, and warns about a missing plate', async () => {
    const mroad = await recognise({ documentType: 'Deckblatt zur Warenanlieferung', company: 'Werk 065', site: 'Werk 065', city: 'Düsseldorf', windowStartLocal: '2026-11-04T09:00', windowEndLocal: '2026-11-04T09:30',
      references: [{ label: 'Borderonummer', value: '10000001' }] });
    expect(mroad.appointment).toMatchObject({ kind: 'DECKBLATT', appointmentLocal: null, windowStartLocal: '2026-11-04T09:00', windowEndLocal: '2026-11-04T09:30' });
    expect(mroad.appointment?.warnings.map((item) => item.code)).toContain('PLATE_MISSING');
    const both = await recognise({ documentType: 'Deckblatt', city: 'Mannheim', appointmentLocal: '2026-11-04T14:00', windowStartLocal: '2026-11-04T14:00', windowEndLocal: '2026-11-04T15:00' });
    expect(both.appointment).toMatchObject({ appointmentLocal: null, windowStartLocal: '2026-11-04T14:00', windowEndLocal: '2026-11-04T15:00' });
  });

  it('sends an mRoad Deckblatt printout as its page together with the text, so the values stay with their labels', async () => {
    let body: { input: Array<{ role: string; content: unknown }> } | null = null;
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output_text: JSON.stringify({ documentKind: 'APPOINTMENT', drafts: [], warnings: [], appointment: { ...blank,
        documentType: 'Deckblatt zur Warenanlieferung', plate: 'B-CY3010', company: 'Werk 065', site: 'Werk 065', city: 'Düsseldorf', stopType: 'UNLOAD',
        windowStartLocal: '2026-11-13T12:00', windowEndLocal: '2026-11-13T12:30', references: [{ label: 'Borderonummer', value: '15015236' }] } }) }));
    });
    const preview = await importPdfPreview(deckblattPdf(), 'DB Düsse 13.11_.pdf', { apiKey: 'test-key', fetchImpl: fetchImpl as typeof fetch, now: new Date('2026-11-12T12:10:00Z') });
    const content = body!.input[1].content as Array<{ type: string; text?: string }>;
    expect(content.map((part) => part.type)).toEqual(['input_file', 'input_text', 'input_text']);
    expect(content[1].text).toContain('065, Düsseldorf');
    expect(content[1].text).toContain('B-CY3010');
    expect(JSON.stringify(body!.input[0])).toContain('Anlieferdatum 13.11.2026 with Von 12:00 and Bis 12:30 is the window 2026-11-13T12:00 to 2026-11-13T12:30');
    expect(preview.readMode).toBe('file');
    expect(preview.appointment).toMatchObject({ kind: 'DECKBLATT', plate: 'B-CY3010', city: 'Düsseldorf', windowStartLocal: '2026-11-13T12:00', windowEndLocal: '2026-11-13T12:30' });
  });

  it('a long Auftrag that mentions a Deckblatt is still read as text only', () => {
    expect(isTerminSlipText({ pages: ['Deckblatt zur Warenanlieferung'] })).toBe(true);
    expect(isTerminSlipText({ pages: ['LKWcontrol Fahrtenschein', 'Seite 2'] })).toBe(true);
    expect(isTerminSlipText({ pages: ['Transportauftrag', 'Deckblatt beilegen', 'Seite 3'] })).toBe(false);
    expect(isTerminSlipText({ pages: ['Transportauftrag Nr. 20566316 Tourbemerkung: Zwickau für MB Düsseldorf'] })).toBe(false);
  });

  it('keeps an Auftrag on the order path', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: JSON.stringify({ documentKind: 'ORDER', appointment: null, warnings: [], drafts: [{ orderNumber: 'A-1', vehicleNumber: null, vehiclePlate: null, trailerPlate: null,
      departmentCompany: null, departmentAddress: null, departmentCity: null, departmentSourcePage: null, tourRemarks: null, tourRemarksSourcePage: null, warnings: [],
      stops: [{ sequence: 1, type: 'LOAD', company: null, address: 'Werkstraße 1, 10115 Berlin', city: 'Berlin', appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null,
        appointmentDateLocal: null, loadingMeters: null, referenceNumbers: [], instructions: null, sourcePage: 1, sourceExcerpt: null, confidence: 0.9 }] }] }) })));
    const preview = await importPdfPreview(Buffer.from('%PDF-1.4'), 'a.pdf', { apiKey: 'k', fetchImpl });
    expect(preview.documentKind).toBe('ORDER');
    expect(preview.drafts).toHaveLength(1);
  });
});

it('converts Berlin wall-clock text across summer and winter time', () => {
  expect(berlinLocalToDate('2026-11-04T09:30')?.toISOString()).toBe('2026-11-04T08:30:00.000Z');
  expect(berlinLocalToDate('2026-07-04T09:30')?.toISOString()).toBe('2026-07-04T07:30:00.000Z');
});

async function tourWith(vehicleNumber: string, plate: string, stops: Array<{ type: string; company: string; address: string; city: string; references?: string[]; appointmentAt?: Date }>) {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber, licensePlate: plate } });
  const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: `ORD-${vehicleNumber}`, status: 'ACTIVE', plannedStartAt: new Date('2026-11-04T05:00:00Z') } });
  const created = [];
  for (const [index, stop] of stops.entries()) {
    created.push(await db.stop.create({ data: { tourId: tour.id, sequence: index + 1, type: stop.type, company: stop.company, address: stop.address, city: stop.city, latitude: 52, longitude: 10,
      referenceNumbersJson: stop.references ? JSON.stringify(stop.references) : null, appointmentAt: stop.appointmentAt ?? null } }));
  }
  return { vehicle, tour, stops: created };
}

const slip = (extra: Partial<AppointmentDocument>): AppointmentDocument => ({ kind: 'VW_FAHRTENSCHEIN', ...blank, warnings: [], ...extra } as AppointmentDocument);

describe('matching a slip to the truck and stop', () => {
  it('finds the unloading stop of the truck by plate and plant city', async () => {
    const { vehicle, stops } = await tourWith('M-1', 'GÖ-FX901', [
      { type: 'LOAD', company: 'Lieferant Nord', address: 'Hafenstraße 2, 38440 Wolfsburg', city: 'Wolfsburg' },
      { type: 'UNLOAD', company: 'Beispiel Truck & Bus SE', address: 'Dachauer Straße 667, 80995 München', city: 'München' }
    ]);
    const match = await matchAppointment(pg(), slip({ plate: 'GO FX 901'.replace('GO', 'GÖ'), company: 'Beispiel Truck & Bus SE München', city: 'München', stopType: 'UNLOAD', appointmentLocal: '2026-11-04T11:00' }));
    expect(match.vehicle).toMatchObject({ status: 'MATCHED', vehicleId: vehicle.id });
    expect(match.status).toBe('MATCHED');
    expect(match.candidates[0]).toMatchObject({ stopId: stops[1].id });
    expect(match.candidates[0].reasons.join(' ')).toContain('город München');
  });

  it('without a plate finds the stop through a shared reference number', async () => {
    const { stops } = await tourWith('M-2', 'B-XX902', [{ type: 'UNLOAD', company: 'Werk 065', address: 'Rather Straße 51, 40476 Düsseldorf', city: 'Düsseldorf', references: ['10000002'] }]);
    await tourWith('M-3', 'B-XX903', [{ type: 'UNLOAD', company: 'Werk Süd', address: 'Rather Straße 51, 40476 Düsseldorf', city: 'Düsseldorf' }]);
    const match = await matchAppointment(pg(), slip({ kind: 'DECKBLATT', company: 'Werk 065', city: 'Düsseldorf', windowStartLocal: '2026-11-04T09:00', windowEndLocal: '2026-11-04T09:30',
      references: [{ label: 'Borderonummer', value: '10000002' }] }));
    expect(match.vehicle.status).toBe('NO_PLATE');
    expect(match.status).toBe('MATCHED');
    expect(match.candidates[0].stopId).toBe(stops[0].id);
  });

  it('asks the dispatcher when two stops fit equally, and reports a plate that is not in OPS', async () => {
    await tourWith('M-4', 'B-XX904', [{ type: 'UNLOAD', company: 'Werk Mitte', address: 'Werkstraße 1, 68305 Mannheim', city: 'Mannheim' }]);
    await tourWith('M-5', 'B-XX905', [{ type: 'UNLOAD', company: 'Werk Mitte', address: 'Werkstraße 1, 68305 Mannheim', city: 'Mannheim' }]);
    const both = await matchAppointment(pg(), slip({ city: 'Mannheim', company: 'Standort Werk Mannheim', stopType: 'UNLOAD', windowStartLocal: '2026-11-04T14:00', windowEndLocal: '2026-11-04T15:00' }));
    expect(both.status).toBe('AMBIGUOUS');
    const unknown = await matchAppointment(pg(), slip({ plate: 'B-ZZ999', city: 'Mannheim', windowStartLocal: '2026-11-04T14:00', windowEndLocal: '2026-11-04T15:00' }));
    expect(unknown.vehicle).toEqual({ status: 'NOT_FOUND', plate: 'B-ZZ999' });
  });

  it('drops a stop planned days away from the slip', async () => {
    await tourWith('M-6', 'B-XX906', [{ type: 'UNLOAD', company: 'Werk Ost', address: 'Oststraße 1, 04103 Leipzig', city: 'Leipzig', appointmentAt: new Date('2026-11-20T08:00:00Z') }]);
    const match = await matchAppointment(pg(), slip({ plate: 'B-XX906', city: 'Leipzig', appointmentLocal: '2026-11-04T09:00' }));
    expect(match.status).toBe('NONE');
  });
});

it('a window replaces the exact time (and back), references are added once, and a stale version is refused', async () => {
  const { tour, stops } = await tourWith('AP-1', 'B-AP001', [{ type: 'UNLOAD', company: 'Werk', address: 'Werkstraße 1, 10115 Berlin', city: 'Berlin', references: ['R-1'], appointmentAt: new Date('2026-11-04T07:00:00Z') }]);
  const service = new AppointmentService(pg());
  const window = { windowStartAt: '2026-11-04T08:00:00.000Z', windowEndAt: '2026-11-04T08:30:00.000Z' };
  const result = await service.apply(stops[0].id, { ...window, version: tour.planVersion }, new Date('2026-11-03T12:00:00Z'), { source: 'DOCUMENT', references: ['R-1', 'T-1'] });
  expect(result).toMatchObject({ appointmentAt: '2026-11-04T08:30:00.000Z', windowStartAt: '2026-11-04T08:00:00.000Z' });
  const stop = await db.stop.findUniqueOrThrow({ where: { id: stops[0].id } });
  expect(stop).toMatchObject({ appointmentAt: null, appointmentWindowStartAt: new Date(window.windowStartAt), appointmentWindowEndAt: new Date(window.windowEndAt) });
  expect(JSON.parse(stop.referenceNumbersJson!)).toEqual(['R-1', 'T-1']);
  await expect(service.apply(stops[0].id, { appointmentAt: '2026-11-04T09:00:00.000Z', version: tour.planVersion }, new Date('2026-11-03T12:00:00Z'))).rejects.toThrow('Маршрут изменился');
  await service.apply(stops[0].id, { appointmentAt: '2026-11-04T09:00:00.000Z', version: tour.planVersion + 1 }, new Date('2026-11-03T12:00:00Z'));
  expect(await db.stop.findUniqueOrThrow({ where: { id: stops[0].id } })).toMatchObject({ appointmentAt: new Date('2026-11-04T09:00:00.000Z'), appointmentWindowStartAt: null, appointmentWindowEndAt: null });
  const event = await db.operationEvent.findFirstOrThrow({ where: { stopId: stops[0].id, type: 'APPOINTMENT_ATTACHED' }, orderBy: { createdAt: 'asc' } });
  expect(JSON.parse(event.payloadJson!)).toMatchObject({ source: 'DOCUMENT', addedReferences: ['R-1', 'T-1'] });
});

it('keeps a slip without a tour, offers it once the Auftrag arrives, and expires it after its day', async () => {
  const pending = new PendingAppointmentService(pg());
  const document = slip({ plate: 'B-PD001', company: 'Werk Nord', city: 'Kassel', stopType: 'UNLOAD', appointmentLocal: '2026-11-04T10:00', references: [{ label: 'Fahrt-ID', value: 'T-PD-0001' }] });
  const fingerprint = documentFingerprint(Buffer.from('slip one'));
  expect(fingerprint).toMatch(/^termin-[0-9a-f]{64}$/);
  const row = await pending.save(document, fingerprint, 'PENDING');
  const publish = vi.fn(async () => undefined);
  await pending.scan(publish, new Date('2026-11-03T12:00:00Z'));
  expect(publish).not.toHaveBeenCalled();

  const { stops } = await tourWith('PD-1', 'B-PD001', [{ type: 'UNLOAD', company: 'Werk Nord', address: 'Nordstraße 1, 34117 Kassel', city: 'Kassel' }]);
  await pending.scan(publish, new Date('2026-11-03T12:00:00Z'));
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'APPOINTMENT_MATCH', stopId: stops[0].id, dedupKey: `appointment-match:${row.id}:${stops[0].id}` }));

  await pending.attach(row.id, stops[0].id);
  expect((await pending.findByFingerprint(fingerprint))?.status).toBe('ATTACHED');

  const old = await pending.save(slip({ city: 'Kassel', appointmentLocal: '2026-10-01T10:00' }), documentFingerprint(Buffer.from('old slip')), 'PENDING');
  await pending.list(new Date('2026-11-03T12:00:00Z'));
  expect((await db.pendingAppointment.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('EXPIRED');
});
