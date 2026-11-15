import { describe, expect, it } from 'vitest';
import { checkAddressesAgainstText, NOT_IN_DOCUMENT } from '../src/services/document-text-check.js';
import { scoreDraft } from '../src/services/field-confidence.js';

// A text layer as pdf-text.ts gives it: table columns split by wide gaps, the street and its number in different cells.
const text = { chars: 600, pages: [[
  'Transportauftrag 20565181   Datum 15.11.2026',
  'Ladestelle   Volkswagen AG Werk Kassel   Dr.-Rudolf-Leiding-Platz   1   D-34225 Baunatal',
  'Entladestelle   MAN Truck & Bus SE   Industriestraße Nord 12   38239 Salzgitter',
  'Abteilung  Lager vorladen  Rudolf-Diesel-Str. 2a, 14974 Ludwigsfelde'
].join('\n')] };
const stop = (address: string, extra: Record<string, unknown> = {}) => ({ type: 'UNLOAD' as const, company: 'Firma', address, provenance: 'TABLE', ...extra });
const check = (stops: Array<ReturnType<typeof stop>>) => checkAddressesAgainstText({ drafts: [{ stops, warnings: [] as Array<{ code: string; message: string; stopIndex?: number; field?: string }> }] }, text).drafts[0].warnings;

describe('the address the model read is printed in the Auftrag (owner, 15.11)', () => {
  it('accepts what is printed, however the street is written and wherever the house number stands', () => {
    expect(check([
      stop('Dr.-Rudolf-Leiding-Platz 1, 34225 Baunatal'),
      stop('Industriestr. Nord 12, 38239 Salzgitter'),
      stop('Rudolf-Diesel-Straße 2a, 14974 Ludwigsfelde')
    ])).toEqual([]);
  });

  it('flags a postcode, a street, a house number or a town that the document does not print', () => {
    const warnings = check([
      stop('Dr.-Rudolf-Leiding-Platz 1, 34226 Baunatal'),
      stop('Industriestraße Süd 12, 38239 Salzgitter'),
      stop('Dr.-Rudolf-Leiding-Platz 7, 34225 Baunatal'),
      stop('Industriestraße Nord 12, 38239 Wolfsburg')
    ]);
    expect(warnings.map((warning) => [warning.code, warning.stopIndex, warning.field])).toEqual([
      [NOT_IN_DOCUMENT, 0, 'address'], [NOT_IN_DOCUMENT, 1, 'address'], [NOT_IN_DOCUMENT, 2, 'address'], [NOT_IN_DOCUMENT, 3, 'address']
    ]);
    expect(warnings[0].message).toContain('«34226»');
    expect(warnings[1].message).toContain('Industriestraße Süd');
    expect(warnings[2].message).toContain('Dr.-Rudolf-Leiding-Platz 7');
    expect(warnings[3].message).toContain('«Wolfsburg»');
  });

  it('leaves alone what is not the model\'s reading: a learned rule, a placeholder, another stop\'s note, a bare town', () => {
    expect(check([
      stop('Werkstraße 99, 10115 Berlin', { ruleApplied: true }),
      stop('Werkstraße 99, 10115 Berlin', { provenance: 'PLACEHOLDER' }),
      stop('Werkstraße 99, 10115 Berlin', { provenance: 'OTHER_STOP_NOTE' }),
      stop('Bremen')
    ])).toEqual([]);
  });

  it('makes such an address red in the check, not just yellow', () => {
    const draft = { orderNumber: '1', vehicleNumber: null, stops: [stop('Dr.-Rudolf-Leiding-Platz 7, 34225 Baunatal', { aiConfidence: { address: { c: 0.95, evidence: 'Leiding-Platz' } } })], warnings: [] as Array<{ code: string; message: string; stopIndex?: number; field?: string }> };
    const [checked] = checkAddressesAgainstText({ drafts: [draft] }, text).drafts;
    const scored = scoreDraft(checked as never, { today: '2026-11-15' } as never) as unknown as { stops: Array<{ fieldConfidence: { address: { level: string; reasons: string[] } } }> };
    expect(scored.stops[0].fieldConfidence.address).toMatchObject({ level: 'DOUBT' });
    expect(scored.stops[0].fieldConfidence.address.reasons).toContain('NOT_IN_DOCUMENT');
  });
});
