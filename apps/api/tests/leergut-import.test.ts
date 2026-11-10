import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { BUILT_IN_RULES, applyRulesToStop } from '../src/services/address-rules.js';
import { finishModelAnswer, parseTourRemarksRoute, type LearnedImportRules } from '../src/services/pdf-order-import.js';
import { MockRoutingProvider } from '../src/services/routing.js';
import { withTerminGroups } from '../src/services/termin-groups.js';
import { TourService } from '../src/services/tours.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

const row = (sequence: number, type: 'LOAD' | 'UNLOAD', company: string, address: string, extra: Record<string, unknown> = {}) => ({
  sequence, type, company, address, city: null, appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null, appointmentDateLocal: null,
  loadingMeters: null, referenceNumbers: [], instructions: null, sourcePage: 1, sourceExcerpt: null, confidence: 0.9, ...extra });
const PLANT = 'Industriestraße Nord 1, 38239 Salzgitter';
const hydro = row(1, 'LOAD', 'Hydro Aluminium', 'Gewerbering 1, 08451 Crimmitschau');
const unloading = (extra: Record<string, unknown> = {}) => row(2, 'UNLOAD', 'Volkswagen AG', PLANT, { loadingMeters: 13.6, ...extra });
const leergut = (extra: Record<string, unknown> = {}) => row(3, 'LOAD', 'Volkswagen AG', PLANT, { instructions: 'Leergut', referenceNumbers: ['LG-77'], ...extra });
const read = (tourRemarks: string, stops: unknown[], learned?: Partial<LearnedImportRules>) => finishModelAnswer({ drafts: [{
  orderNumber: 'A-1', vehicleNumber: null, vehiclePlate: null, trailerPlate: null, tourRemarks, tourRemarksSourcePage: 1,
  departmentCompany: null, departmentAddress: null, departmentCity: null, departmentSourcePage: null, stops, warnings: [] }], warnings: [] },
  { layout: 'PDF', learned: learned as LearnedImportRules | undefined }).drafts[0];
const shape = (draft: { stops: Array<{ type: string; city?: string | null; appointmentLocal: string | null; samePlaceAsPrevious?: boolean }> }) =>
  draft.stops.map((stop) => [stop.type, stop.city, stop.appointmentLocal, Boolean(stop.samePlaceAsPrevious)]);
const warning = (draft: { warnings: Array<{ code: string; message: string; stopIndex?: number; field?: string }> }, code: string) => draft.warnings.find((item) => item.code === code);

describe('unloading and Leergut loading at one plant in an Auftrag', () => {
  it('stay two stops with one Termin, kept on the unloading', () => {
    const draft = read('Hydro Crimmitschau für VW SZ', [hydro, unloading({ appointmentLocal: '2026-11-12T08:00' }), leergut()]);
    expect(shape(draft)).toEqual([['LOAD', 'Crimmitschau', null, false], ['UNLOAD', 'Salzgitter', '2026-11-12T08:00', false], ['LOAD', 'Salzgitter', null, true]]);
    expect(draft.stops.map((stop) => stop.sequence)).toEqual([1, 2, 3]);
    // What belongs to the loading stays with it: the unloading keeps its own Lademeter and gets no Leergut note.
    expect(draft.stops[1]).toMatchObject({ loadingMeters: 13.6, instructions: null, referenceNumbers: [] });
    expect(draft.stops[2]).toMatchObject({ address: PLANT, instructions: 'Leergut', referenceNumbers: ['LG-77'], provenance: 'TOUR_REMARKS' });
    expect(warning(draft, 'SHARED_TERMIN')!.message).toBe('Выгрузка и загрузка в Salzgitter — одно место: общий Termin 08:00 стоит на точке 2.');
    expect(warning(draft, 'ABBREVIATION_FROM_ADDRESS')).toMatchObject({ stopIndex: 1 });
    expect(warning(draft, 'TABLE_STOPS_NOT_IN_TOUR_REMARKS')).toBeUndefined();
  });

  it('move a Termin printed only for the Leergut to the unloading, and keep an equal one once', () => {
    const moved = read('Hydro Crimmitschau für VW SZ', [hydro, unloading(), leergut({ appointmentLocal: '2026-11-12T08:00' })]);
    expect(shape(moved).slice(1)).toEqual([['UNLOAD', 'Salzgitter', '2026-11-12T08:00', false], ['LOAD', 'Salzgitter', null, true]]);
    const equal = read('Hydro Crimmitschau für VW SZ', [hydro, unloading({ appointmentLocal: '2026-11-12T08:00' }), leergut({ appointmentLocal: '2026-11-12T08:00' })]);
    expect(shape(equal)).toEqual(shape(moved));
    const none = read('Hydro Crimmitschau für VW SZ', [hydro, unloading(), leergut()]);
    expect(warning(none, 'SHARED_TERMIN')!.message).toBe('Выгрузка и загрузка в Salzgitter — одно место: Termin у них общий, он ставится на точку 2.');
  });

  it('keep two different Termine and ask the dispatcher; the earlier printed time is served first', () => {
    const draft = read('Hydro Crimmitschau für VW SZ', [hydro, unloading({ appointmentLocal: '2026-11-12T08:00' }), leergut({ appointmentLocal: '2026-11-12T14:00' })]);
    expect(shape(draft).slice(1)).toEqual([['UNLOAD', 'Salzgitter', '2026-11-12T08:00', false], ['LOAD', 'Salzgitter', '2026-11-12T14:00', true]]);
    expect(warning(draft, 'SHARED_TERMIN_CONFLICT')).toMatchObject({ stopIndex: 2, field: 'time',
      message: 'В Salzgitter у выгрузки и загрузки разные Termin (08:00 и 14:00) — проверьте, два это окна или одно.' });
    expect(warning(draft, 'SHARED_TERMIN')).toBeUndefined();

    const loadFirst = read('Hydro Crimmitschau für VW SZ', [hydro, unloading({ appointmentLocal: '2026-11-12T14:00' }), leergut({ appointmentLocal: '2026-11-12T06:00' })]);
    expect(shape(loadFirst).slice(1)).toEqual([['LOAD', 'Salzgitter', '2026-11-12T06:00', false], ['UNLOAD', 'Salzgitter', '2026-11-12T14:00', true]]);
    expect(warning(loadFirst, 'SHARED_TERMIN_CONFLICT')!.message).toBe('В Salzgitter у загрузки и выгрузки разные Termin (06:00 и 14:00) — проверьте, два это окна или одно.');
    // The decoded city code still points at the unloading, now the third stop.
    expect(warning(loadFirst, 'ABBREVIATION_FROM_ADDRESS')).toMatchObject({ stopIndex: 2 });
  });

  it('are not turned into two stops of one type by a learned stop type', () => {
    const learned = { stopTypes: { 'volkswagen ag salzgitter': 'LOAD' as const } };
    // The rule works on a table without a Tourbemerkung route…
    expect(read('', [hydro, unloading()], learned).stops[1]).toMatchObject({ type: 'LOAD' });
    // …and leaves the pair alone.
    expect(read('Hydro Crimmitschau für VW SZ', [hydro, unloading(), leergut()], learned).stops.map((stop) => stop.type)).toEqual(['LOAD', 'UNLOAD', 'LOAD']);
  });

  it('are still one stop when both rows unload, and a loading place does not take the unloading of a round trip', () => {
    const twoShipments = read('Hydro Crimmitschau für VW SZ', [hydro, unloading(), row(3, 'UNLOAD', 'Volkswagen AG', PLANT, { loadingMeters: 2 })]);
    expect(shape(twoShipments)).toEqual([['LOAD', 'Crimmitschau', null, false], ['UNLOAD', 'Salzgitter', null, false]]);
    expect(twoShipments.stops[1]).toMatchObject({ loadingMeters: 15.6 });
    const roundTrip = read('Hydro Crimmitschau für VW SZ', [hydro, unloading(), row(3, 'UNLOAD', 'Hydro Aluminium', 'Gewerbering 1, 08451 Crimmitschau')]);
    expect(roundTrip.stops.map((stop) => stop.type)).toEqual(['LOAD', 'UNLOAD']);
  });

  it('ask for the Termin of the plant once', () => {
    const draft = read('Hydro Crimmitschau für VW SZ', [hydro, unloading(), leergut()]);
    const [, lead, follower] = draft.stops.map((stop) => applyRulesToStop(stop, BUILT_IN_RULES));
    expect([lead.terminRequired, follower.terminRequired]).toEqual([true, false]);
  });
});

describe('a Tourbemerkung written as a chain', () => {
  it('«A --> B --> C» unloads at B, loads there again and unloads at C', () => {
    expect(parseTourRemarksRoute('Hydro Crimmitschau --> VW SZ --> Seifert Bremen')!.map((stop) => [stop.type, stop.label, Boolean(stop.thenLoad)]))
      .toEqual([['LOAD', 'Hydro Crimmitschau', false], ['UNLOAD', 'VW SZ', true], ['UNLOAD', 'Seifert Bremen', false]]);
    expect(parseTourRemarksRoute('Hydro Crimmitschau --> VW SZ')!.some((stop) => stop.thenLoad)).toBe(false);
  });

  it('puts the loading at the address of the unloading when no row prints it, and says so', () => {
    const bremen = row(3, 'UNLOAD', 'Seifert Logistics', 'Hafenstraße 5, 28195 Bremen');
    const draft = read('Hydro Crimmitschau --> VW SZ --> Seifert Bremen', [hydro, unloading({ appointmentLocal: '2026-11-12T08:00' }), bremen]);
    expect(shape(draft)).toEqual([['LOAD', 'Crimmitschau', null, false], ['UNLOAD', 'Salzgitter', '2026-11-12T08:00', false],
      ['LOAD', 'Salzgitter', null, true], ['UNLOAD', 'Bremen', null, false]]);
    expect(draft.stops[2]).toMatchObject({ address: PLANT, loadingMeters: null, confidence: 0.5 });
    expect(warning(draft, 'ROUTE_CHAIN')).toMatchObject({ stopIndex: 1, message: 'Tourbemerkung — цепочка: в Salzgitter поставлены выгрузка и загрузка. Проверьте порядок точек.' });
  });

  it('uses the printed Leergut row for the loading when there is one', () => {
    const bremen = row(4, 'UNLOAD', 'Seifert Logistics', 'Hafenstraße 5, 28195 Bremen');
    const draft = read('Hydro Crimmitschau --> VW SZ --> Seifert Bremen', [hydro, unloading(), leergut(), bremen]);
    expect(draft.stops.map((stop) => stop.type)).toEqual(['LOAD', 'UNLOAD', 'LOAD', 'UNLOAD']);
    expect(draft.stops[2]).toMatchObject({ instructions: 'Leergut', confidence: 0.9 });
  });
});

describe('the confirmed Auftrag as a tour', () => {
  let db: PrismaClient;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-leergut-import-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
  }, 20_000);
  afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it('has the Termin once: the Leergut stop is served under the Termin of the unloading and owes none', async () => {
    const draft = read('Hydro Crimmitschau für VW SZ', [hydro, unloading(), leergut({ appointmentLocal: '2026-11-12T08:00' })]);
    const coordinates = [{ latitude: 50.81, longitude: 12.39 }, { latitude: 52.19, longitude: 10.4 }, { latitude: 52.19, longitude: 10.4 }];
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: 'LG1', licensePlate: 'GÖ-LG 101' } });
    const tour = await new TourService(asAppDatabase(db), new MockRoutingProvider()).createTour({ vehicleId: vehicle.id, orderNumber: 'LG1',
      stops: draft.stops.map((stop, index) => ({ sequence: stop.sequence, type: stop.type, company: stop.company ?? undefined, address: stop.address!, city: stop.city ?? undefined, ...coordinates[index],
        appointmentAt: stop.appointmentLocal ? new Date(`${stop.appointmentLocal}:00+01:00`).toISOString() : null })) });
    const stops = await db.stop.findMany({ where: { tourId: tour.id }, orderBy: { sequence: 'asc' } });
    expect(stops.map((stop) => [stop.type, stop.appointmentAt?.toISOString() ?? null, stop.terminRequired])).toEqual([
      ['LOAD', null, false], ['UNLOAD', '2026-11-12T07:00:00.000Z', false], ['LOAD', null, false]]);
    expect(withTerminGroups(stops).map((stop) => stop.terminSharedWithStopId)).toEqual([null, null, stops[1].id]);
  });
});
