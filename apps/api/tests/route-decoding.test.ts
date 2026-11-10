import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { AddressRuleService } from '../src/services/address-rules.js';
import { finishModelAnswer, type LearnedImportRules } from '../src/services/pdf-order-import.js';
import { decodeCityCode, foldGerman, isAbbreviationOf, looksLikeCityCode } from '../src/services/route-decoding.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

describe('a city code of a Tourbemerkung', () => {
  it('fits a town when its letters follow in order from the first one', () => {
    expect(isAbbreviationOf('SZ', 'Salzgitter')).toBe(true);
    expect(isAbbreviationOf('WOB', 'Wolfsburg')).toBe(true);
    expect(isAbbreviationOf('GÖ', 'Göttingen')).toBe(true);
    expect(isAbbreviationOf('GOE', 'Göttingen')).toBe(true);
    expect(isAbbreviationOf('SZ', 'Wolfsburg')).toBe(false);
    expect(isAbbreviationOf('ZS', 'Salzgitter')).toBe(false);
    // One letter fits half of Germany; a full name is no abbreviation of itself.
    expect(isAbbreviationOf('S', 'Salzgitter')).toBe(false);
    expect(isAbbreviationOf('Kassel', 'Kassel')).toBe(false);
    expect(foldGerman('Düsseldorf-Süd')).toBe('duesseldorfsued');
  });

  it('is one to four capital letters, never a word or a code with digits', () => {
    for (const code of ['SZ', 'WOB', 'H', 'GÖ']) expect(looksLikeCityCode(code)).toBe(true);
    for (const text of ['für', 'Sz', 'ES2', 'KASSEL', '', null]) expect(looksLikeCityCode(text)).toBe(false);
  });

  it('is explained by the addresses of the Auftrag first, then by the dictionary, else by nobody', () => {
    expect(decodeCityCode('SZ', ['Zwickau', 'Salzgitter', 'Wolfsburg'], { sz: 'Schwarzenberg' })).toEqual({ city: 'Salzgitter', source: 'ADDRESS' });
    // Two towns fit: the addresses do not decide, the dictionary does.
    expect(decodeCityCode('SZ', ['Salzgitter', 'Schwarzenberg'], { sz: 'Salzgitter' })).toEqual({ city: 'Salzgitter', source: 'RULE' });
    expect(decodeCityCode('SZ', ['Salzgitter', 'Schwarzenberg'])).toBeNull();
    expect(decodeCityCode('H', ['Hannover'], { h: 'Hannover' })).toEqual({ city: 'Hannover', source: 'RULE' });
    expect(decodeCityCode('QX', ['Salzgitter'])).toBeNull();
    expect(decodeCityCode('Salzgitter', ['Salzgitter'])).toBeNull();
  });
});

describe('reading a Tourbemerkung with a city code', () => {
  const row = (sequence: number, type: 'LOAD' | 'UNLOAD', company: string, address: string, extra: Record<string, unknown> = {}) => ({
    sequence, type, company, address, city: null, appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null, appointmentDateLocal: null,
    loadingMeters: null, referenceNumbers: [], instructions: null, sourcePage: 1, sourceExcerpt: null, confidence: 0.9, ...extra });
  const hydro = row(1, 'LOAD', 'Hydro Aluminium', 'Gewerbering 1, 08451 Crimmitschau');
  const salzgitter = row(2, 'UNLOAD', 'Volkswagen AG', 'Industriestraße Nord 1, 38239 Salzgitter');
  const wolfsburg = row(3, 'UNLOAD', 'Volkswagen AG', 'Berliner Ring 2, 38440 Wolfsburg');
  const read = (tourRemarks: string, stops: unknown[], learned?: Partial<LearnedImportRules>) => finishModelAnswer({ drafts: [{
    orderNumber: 'A-1', vehicleNumber: null, vehiclePlate: null, trailerPlate: null, tourRemarks, tourRemarksSourcePage: 1,
    departmentCompany: null, departmentAddress: null, departmentCity: null, departmentSourcePage: null, stops, warnings: [] }], warnings: [] },
    { layout: 'PDF', learned: learned as LearnedImportRules | undefined }).drafts[0];
  const codes = (draft: { warnings: Array<{ code: string }> }) => draft.warnings.map((warning) => warning.code);

  it('«VW SZ» with a VW address in Salzgitter is Salzgitter, without a placeholder and without a question', () => {
    const draft = read('Hydro Crimmitschau für VW SZ', [hydro, salzgitter, wolfsburg]);
    expect(draft.stops.map((stop) => [stop.type, stop.address])).toEqual([['LOAD', 'Gewerbering 1, 08451 Crimmitschau'], ['UNLOAD', 'Industriestraße Nord 1, 38239 Salzgitter']]);
    expect(draft.stops[1]).toMatchObject({ city: 'Salzgitter', provenance: 'TOUR_REMARKS' });
    expect(codes(draft)).toContain('ABBREVIATION_FROM_ADDRESS');
    expect(draft.warnings.find((warning) => warning.code === 'ABBREVIATION_FROM_ADDRESS')).toMatchObject({ stopIndex: 1, message: '«SZ» — это Salzgitter: так написан адрес в Auftrag.' });
    expect(codes(draft)).not.toContain('UNKNOWN_ABBREVIATION');
    expect(codes(draft)).not.toContain('TOUR_REMARKS_STOP_NOT_FOUND');
  });

  it('«VW WOB» takes the Wolfsburg row, not the Salzgitter one', () => {
    const draft = read('Hydro Crimmitschau für VW WOB', [hydro, salzgitter, wolfsburg]);
    expect(draft.stops[1]).toMatchObject({ address: 'Berliner Ring 2, 38440 Wolfsburg', city: 'Wolfsburg' });
  });

  it('asks what a code means when neither the addresses nor the dictionary explain it, and stops asking once it was taught', () => {
    const draft = read('Hydro Crimmitschau für VW QX', [hydro, salzgitter, wolfsburg]);
    const question = draft.warnings.find((warning) => warning.code === 'UNKNOWN_ABBREVIATION');
    expect(question).toMatchObject({ stopIndex: 1, field: 'city', abbreviation: 'QX', options: ['Crimmitschau', 'Salzgitter', 'Wolfsburg'] });
    expect(question!.message).toBe('Сокращение «QX» в Tourbemerkung («VW QX») не расшифровано. Напишите, что оно значит, — оно запомнится для следующих Auftrag.');
    expect(codes(draft)).not.toContain('TOUR_REMARKS_STOP_NOT_FOUND');
    expect(draft.stops[1]).toMatchObject({ provenance: 'PLACEHOLDER' });

    const taught = read('Hydro Crimmitschau für VW QX', [hydro, salzgitter, wolfsburg], { cityCodes: { qx: 'Salzgitter' } });
    expect(taught.stops[1]).toMatchObject({ address: 'Industriestraße Nord 1, 38239 Salzgitter', provenance: 'TOUR_REMARKS' });
    expect(codes(taught)).not.toContain('UNKNOWN_ABBREVIATION');
    expect(codes(taught)).not.toContain('ABBREVIATION_FROM_ADDRESS');
  });

  it('spells a known code out even when the Auftrag prints no address for it, and never asks about a company or a full town', () => {
    const audi = read('Hydro Crimmitschau für Audi IN', [hydro]);
    expect(audi.stops[1]).toMatchObject({ city: 'Ingolstadt', provenance: 'PLACEHOLDER' });
    expect(codes(audi)).toContain('TOUR_REMARKS_STOP_NOT_FOUND');
    expect(codes(audi)).not.toContain('UNKNOWN_ABBREVIATION');

    for (const remark of ['Hydro Crimmitschau für MAN', 'Hydro Crimmitschau für VW Kassel', 'Hydro Crimmitschau für ES2 Salzgitter']) {
      expect(codes(read(remark, [hydro, salzgitter]))).not.toContain('UNKNOWN_ABBREVIATION');
    }
  });
});

describe('teaching a city code', () => {
  let db: PrismaClient;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-codes-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
  }, 20_000);
  afterAll(async () => {
    await db?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('applies at once, is audited, can be corrected and never overwrites a learned place', async () => {
    const rules = new AddressRuleService(asAppDatabase(db));
    const actor = { role: 'dispatcher' as const, sessionId: 's', dispatcherId: 'd1' };
    const saved = await rules.learnCityCode('SZ', ' Salzgitter ', actor);
    expect(saved).toMatchObject({ pattern: 'sz', kind: 'CITY_CODE', city: 'Salzgitter' });
    expect((await rules.all()).find((rule) => rule.pattern === 'sz')).toMatchObject({ kind: 'CITY_CODE', city: 'Salzgitter', builtIn: false });
    expect(await db.auditLog.findFirst({ where: { action: 'ADDRESS_RULE_CREATED' } })).toMatchObject({ entityId: saved!.id, actorRole: 'dispatcher' });

    expect(await rules.learnCityCode('sz', 'Schwarzenberg', actor)).toMatchObject({ id: saved!.id, city: 'Schwarzenberg' });
    // A built-in code can be overruled the same way.
    expect(await rules.learnCityCode('H', 'Hamburg', actor)).toMatchObject({ pattern: 'h', city: 'Hamburg' });

    await rules.learn({ sourceLabel: 'TST', company: 'TST Süderelbe', street: 'Dradenauer Deichweg 3', postalCode: '21129', city: 'Hamburg', latitude: 53.5, longitude: 9.9 }, actor);
    expect(await rules.learnCityCode('TST', 'Trostberg', actor)).toBeNull();
    expect(await rules.learnCityCode('ES2', 'Essen', actor)).toBeNull();
    expect(await rules.learnCityCode('LONGER', 'Essen', actor)).toBeNull();
    expect(await rules.learnCityCode('XY', ' ', actor)).toBeNull();
  });
});
