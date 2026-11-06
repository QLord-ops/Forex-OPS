import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/sqlite-client/index.js';
import { AddressRuleService } from '../src/services/address-rules.js';
import { deriveRuleCandidates, diffImportedStops, ImportLearningService, pickDraft } from '../src/services/import-learning.js';
import { asAppDatabase, migrateTestDatabase } from './test-database.js';

const actor = { role: 'dispatcher' as const, sessionId: 's1', dispatcherId: 'd1' };

// The Schnellecke Auftrag 71123727 as the AI read it before PR #60: a stop «LG», «MB» unresolved, Lager as Abteilung.
const previewStops = [
  { sequence: 1, type: 'LOAD' as const, company: 'MB', address: 'Düsseldorf', city: 'Düsseldorf', sourceExcerpt: 'MB Düsseldorf 477339 070A', sourceLabel: 'MB Düsseldorf' },
  { sequence: 2, type: 'LOAD' as const, company: 'LG', address: 'LG', city: null, sourceExcerpt: '070D LG' },
  { sequence: 3, type: 'UNLOAD' as const, company: 'Schnellecke Transportlogistik GmbH', address: 'Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde', city: 'Ludwigsfelde', sourceExcerpt: 'Abteilung' }
];
const tourRemarks = 'MB Düsseldorf 477339 070A & 070D LG --> Lager';
const confirmedStops = [
  { sequence: 1, type: 'LOAD' as const, company: 'Mercedes-Benz AG / Werk 065', address: 'Toulouser Allee 26, 40476 Düsseldorf', city: 'Düsseldorf', latitude: 51.24, longitude: 6.79, geocodePrecision: 'EXACT', draftStopIndex: 0 },
  { sequence: 2, type: 'UNLOAD' as const, company: 'Schnellecke Transportlogistik GmbH', address: 'Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde', city: 'Ludwigsfelde', latitude: 52.3, longitude: 13.25, geocodePrecision: 'EXACT', draftStopIndex: 2 }
];

describe('diffImportedStops', () => {
  it('finds the removed «LG» stop with its Tourbemerkung label and the renamed MB company', () => {
    const corrections = diffImportedStops(previewStops, confirmedStops, { tourRemarks });
    expect(corrections.map((item) => [item.kind, item.field, item.aiValue, item.finalValue])).toEqual([
      ['FIELD_CHANGED', 'company', 'MB', 'Mercedes-Benz AG / Werk 065'],
      ['FIELD_CHANGED', 'address', 'Düsseldorf', 'Toulouser Allee 26, 40476 Düsseldorf'],
      ['STOP_REMOVED', null, 'LG, LG', null]
    ]);
    const removed = corrections[2];
    expect(removed.context).toMatchObject({ tourRemarksLabel: 'LG', stopType: 'LOAD' });
    expect(removed.signature).toBe('STOP_REMOVED::lg:');
    expect(corrections[0].signature).toBe('FIELD_CHANGED:company:mb:mercedes benz ag werk 065');
    expect(corrections[0].context).toMatchObject({ sourceLabel: 'MB Düsseldorf', latitude: 51.24, geocodePrecision: 'EXACT' });
  });

  it('pairs stops without indices by company or city and reports an added stop and a type flip', () => {
    const corrections = diffImportedStops(
      [{ sequence: 1, type: 'LOAD', company: 'Hydro Aluminium', address: 'Crimmitschau', city: 'Crimmitschau' }, { sequence: 2, type: 'UNLOAD', company: 'VW', address: 'Kassel', city: 'Kassel' }],
      [
        { sequence: 1, type: 'LOAD', company: 'Hydro Aluminium Rolled Products', address: 'Industriestraße 1, 08451 Crimmitschau', city: 'Crimmitschau' },
        { sequence: 2, type: 'LOAD', company: 'Volkswagen AG', address: 'Dr.-Rudolf-Leiding-Platz 1, 34225 Baunatal', city: 'Kassel' },
        { sequence: 3, type: 'UNLOAD', company: 'BLG', address: 'Senator-Mester-Straße 17, 28197 Bremen', city: 'Bremen' }
      ]
    );
    expect(corrections.map((item) => [item.kind, item.field])).toEqual([
      ['FIELD_CHANGED', 'company'], ['FIELD_CHANGED', 'address'],
      ['FIELD_CHANGED', 'company'], ['FIELD_CHANGED', 'address'], ['FIELD_CHANGED', 'type'],
      ['STOP_ADDED', null]
    ]);
    expect(corrections[4]).toMatchObject({ aiValue: 'UNLOAD', finalValue: 'LOAD', signature: 'FIELD_CHANGED:type:volkswagen ag kassel:load' });
    expect(corrections[5]).toMatchObject({ finalValue: 'BLG, Senator-Mester-Straße 17, 28197 Bremen' });
  });

  it('ignores notes, references and times: an unchanged tour yields nothing', () => {
    expect(diffImportedStops(previewStops.slice(0, 1), [{ sequence: 1, type: 'LOAD', company: 'MB', address: 'Düsseldorf', city: 'Düsseldorf', draftStopIndex: 0 }])).toEqual([]);
  });
});

describe('deriveRuleCandidates', () => {
  const corrections = diffImportedStops(previewStops, confirmedStops, { tourRemarks });
  it('turns a renamed short token into an alias and a removed one-word label into an ignored label', () => {
    expect(deriveRuleCandidates(corrections[0])).toEqual([{ kind: 'ALIAS', pattern: 'mb', value: 'Mercedes-Benz AG / Werk 065' }]);
    expect(deriveRuleCandidates(corrections[1])).toEqual([]);
    expect(deriveRuleCandidates(corrections[2])).toEqual([{ kind: 'IGNORE_LABEL', pattern: 'lg', value: null }]);
  });
  it('never ignores a real place the dispatcher dropped from one tour and never aliases a long name', () => {
    const removed = diffImportedStops([{ sequence: 1, type: 'UNLOAD', company: 'Volkswagen AG', address: 'Dr.-Rudolf-Leiding-Platz 1, 34225 Baunatal', city: 'Kassel', sourceExcerpt: 'VW Kassel Dr.-Rudolf-Leiding-Platz 1' }], [], { tourRemarks: 'Hydro Crimmitschau für VW Kassel' });
    expect(removed[0].context.tourRemarksLabel).toBe('VW Kassel');
    expect(deriveRuleCandidates(removed[0])).toEqual([]);
    const renamed = diffImportedStops([{ sequence: 1, type: 'LOAD', company: 'Vollmann Sachsen', address: 'Scheibenberg', city: 'Scheibenberg' }], [{ sequence: 1, type: 'LOAD', company: 'Vollmann (Sachsen) GmbH & Co. KG', address: 'Elterleiner Str. 4, 09481 Scheibenberg', city: 'Scheibenberg', draftStopIndex: 0 }]);
    expect(deriveRuleCandidates(renamed[0])).toEqual([]);
  });
  it('remembers the type the dispatcher gives a place', () => {
    const flipped = diffImportedStops([{ sequence: 1, type: 'UNLOAD', company: 'BLG', address: 'Bremen', city: 'Bremen' }], [{ sequence: 1, type: 'LOAD', company: 'BLG', address: 'Senator-Mester-Straße 17, 28197 Bremen', city: 'Bremen', draftStopIndex: 0 }]);
    expect(deriveRuleCandidates(flipped.find((item) => item.field === 'type')!)).toEqual([{ kind: 'STOP_TYPE', pattern: 'blg bremen', value: 'LOAD' }]);
  });
});

describe('ImportLearningService', () => {
  let directory: string;
  let db: PrismaClient;
  let service: ImportLearningService;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ops-import-learning-'));
    db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, 'test.db')}` } } });
    await migrateTestDatabase(db);
    service = new ImportLearningService(asAppDatabase(db), new AddressRuleService(asAppDatabase(db)));
  });
  afterEach(async () => { await db.$disconnect(); await rm(directory, { recursive: true, force: true }); });

  async function document(id: string, stops = previewStops) {
    return db.orderDocument.create({ data: { sha256: id.padEnd(64, '0'), filename: `${id}.pdf`, mimeType: 'application/pdf', size: 1, content: Buffer.from(id), status: 'ATTACHED', attachedAt: new Date(),
      previewJson: JSON.stringify({ drafts: [{ orderNumber: '71123727', tourRemarks, stops }] }), confirmedJson: JSON.stringify({ tourRemarks, stops: confirmedStops }) }, select: { id: true } });
  }
  const confirm = (documentId: string) => service.recordConfirmation({ documentId, tourId: null, dispatcherId: 'd1', preview: { drafts: [{ orderNumber: '71123727', tourRemarks, stops: previewStops }] }, orderNumber: '71123727', confirmedStops, tourRemarks, actor });

  it('stores corrections once per document and activates a rule at the second document', async () => {
    const first = await document('a');
    expect(await confirm(first.id)).toMatchObject({ corrections: 3, rules: [{ kind: 'ALIAS', pattern: 'mb' }, { kind: 'IGNORE_LABEL', pattern: 'lg' }] });
    expect(await confirm(first.id)).toEqual({ corrections: 0, rules: [] });
    expect(await db.importCorrection.count()).toBe(3);
    let rule = await db.importRule.findUniqueOrThrow({ where: { kind_pattern: { kind: 'ALIAS', pattern: 'mb' } } });
    expect(rule).toMatchObject({ hits: 1, active: false, value: 'Mercedes-Benz AG / Werk 065' });
    expect((await service.learned()).aliases.mb).toBe('Mercedes-Benz AG');

    const second = await document('b');
    await confirm(second.id);
    rule = await db.importRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(rule).toMatchObject({ hits: 2, active: true });
    expect(await db.auditLog.count({ where: { action: 'IMPORT_RULE_ACTIVATED' } })).toBe(2);
    const learned = await service.learned();
    expect(learned.aliases.mb).toBe('Mercedes-Benz AG / Werk 065');
    expect(learned.rulesText).toContain("'MB' means the company Mercedes-Benz AG / Werk 065.");
    expect(learned.examplesText).toContain("Tourbemerkung 'MB Düsseldorf 477339 070A & 070D LG --> Lager' → 1 LOAD Mercedes-Benz AG / Werk 065, Düsseldorf; 2 UNLOAD Schnellecke Transportlogistik GmbH, Ludwigsfelde.");
    expect(learned.examplesText).not.toContain('Toulouser');
    // The corrected address became a site rule for «MB Düsseldorf».
    expect(await db.addressRule.findFirst({ where: { pattern: 'mb dusseldorf' } })).toMatchObject({ kind: 'SITE', street: 'Toulouser Allee 26', postalCode: '40476', city: 'Düsseldorf' });
  });

  it('keeps a rule off once a dispatcher switched it off, and drops rules on request', async () => {
    const [a, b, c] = await Promise.all([document('a'), document('b'), document('c')]);
    await confirm(a.id); await confirm(b.id);
    const rule = await db.importRule.findUniqueOrThrow({ where: { kind_pattern: { kind: 'ALIAS', pattern: 'mb' } } });
    await service.update(rule.id, { active: false }, actor);
    await confirm(c.id);
    expect(await db.importRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ hits: 3, active: false });
    expect((await service.learned()).aliases.mb).toBe('Mercedes-Benz AG');
    expect(await db.auditLog.count({ where: { action: 'IMPORT_RULE_UPDATED' } })).toBe(1);
    await service.remove(rule.id, actor);
    expect((await db.importRule.findMany()).map((row) => row.pattern)).toEqual(['lg']);
    expect(await db.auditLog.count({ where: { action: 'IMPORT_RULE_DELETED' } })).toBe(1);
    expect(await service.correctionsSince(new Date(Date.now() - 60_000))).toBe(9);
  });

  it('picks the draft by Auftrag number and gives up on an unknown one', () => {
    const preview = { drafts: [{ orderNumber: '1', stops: [] }, { orderNumber: '2', stops: [] }] };
    expect(pickDraft(preview, '2')).toMatchObject({ orderNumber: '2' });
    expect(pickDraft(preview, '3')).toBeNull();
    expect(pickDraft({ drafts: [{ orderNumber: '1', stops: [] }] }, '9')).toMatchObject({ orderNumber: '1' });
    expect(pickDraft(null, '1')).toBeNull();
  });
});
