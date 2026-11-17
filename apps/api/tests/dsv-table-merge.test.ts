import { describe, expect, it } from 'vitest';
import { finishModelAnswer } from '../src/services/pdf-order-import.js';
import { normalizeAiSchedule } from '../src/services/order-dates.js';

// Owner, 17.11.2026: DSV Fahrauftrag, Tour-Referenz 000000788548 — six rows of the stop table, three places.
type Row = { type: 'LOAD' | 'UNLOAD'; company: string; address: string; city: string; start?: string; end?: string; refs?: string[] };
const row = (sequence: number, item: Row) => ({
  sequence, type: item.type, company: item.company, address: item.address, city: item.city,
  appointmentLocal: null, appointmentWindowStartLocal: item.start ?? null, appointmentWindowEndLocal: item.end ?? null, appointmentDateLocal: null,
  loadingMeters: null, referenceNumbers: item.refs ?? [], instructions: null, sourcePage: 1, sourceExcerpt: null, confidence: 0.9
});
const order = (rows: Row[]) => ({
  documentKind: 'ORDER', appointment: null, warnings: [], documentIssuer: 'DSV', customerKey: null,
  drafts: [{ orderNumber: '000000788548', vehicleNumber: null, vehiclePlate: 'B-CY3360', trailerPlate: null, tourRemarks: 'L 70KWH-85PAR+85ECH#BMW 70806',
    tourRemarksSourcePage: 1, departmentCompany: null, departmentAddress: null, departmentCity: null, departmentSourcePage: null, carrierAddress: null, warnings: [],
    stops: rows.map((item, index) => row(index + 1, item)) }]
});
const dsv788548: Row[] = [
  { type: 'LOAD', company: 'DSV KOR STUTTGART GMBH & CO.KG', address: 'Rudolf-Diesel-Strasse 2, 70806 Kornwestheim', city: 'Kornwestheim', start: '2026-11-19T04:00', end: '2026-11-19T04:00', refs: ['788548'] },
  { type: 'UNLOAD', company: 'VZ PARSDORF', address: 'Am Gewerbepark 1, 85599 Parsdorf', city: 'Parsdorf' },
  { type: 'UNLOAD', company: 'VZ PARSDORF', address: 'Am Gewerbepark 1, 85599 Parsdorf', city: 'Parsdorf', start: '2026-11-19T07:00', end: '2026-11-19T14:00', refs: ['OHNE'] },
  { type: 'UNLOAD', company: 'BMW VZ ECHING', address: 'FREISINGER STR. 15-19, 85386 Eching', city: 'Eching' },
  { type: 'UNLOAD', company: 'BMW VZ ECHING', address: 'FREISINGER STR. 15-19, 85386 Eching', city: 'Eching' },
  { type: 'UNLOAD', company: 'BMW AG VZE Werk 1.8', address: 'Freisinger Str. 15-19, 85386 Eching', city: 'Eching', start: '2026-11-19T10:30', end: '2026-11-19T10:30', refs: ['18000305538'] }
];
const read = (rows: Row[]) => finishModelAnswer(order(rows), { layout: 'PDF', readMode: 'text' }).drafts[0]!;

describe('rows of the stop table at one address are one stop', () => {
  it('turns the six rows of DSV 788548 into Kornwestheim → Parsdorf → Eching', () => {
    const draft = read(dsv788548);
    expect(draft.stops.map((stop) => [stop.type, stop.city])).toEqual([['LOAD', 'Kornwestheim'], ['UNLOAD', 'Parsdorf'], ['UNLOAD', 'Eching']]);
    expect(draft.stops.map((stop) => stop.sequence)).toEqual([1, 2, 3]);
    expect(draft.stops[1]).toMatchObject({ company: 'VZ PARSDORF', appointmentWindowStartLocal: '2026-11-19T07:00', appointmentWindowEndLocal: '2026-11-19T14:00', referenceNumbers: ['OHNE'] });
    expect(draft.stops[2]).toMatchObject({ company: 'BMW VZ ECHING', appointmentLocal: '2026-11-19T10:30', appointmentWindowStartLocal: null, referenceNumbers: ['18000305538'] });
    expect(draft.warnings.filter((warning) => warning.code === 'SAME_PLACE_ROWS_MERGED').map((warning) => [warning.stopIndex, warning.message]))
      .toEqual([[1, expect.stringContaining('Строки 2, 3 таблицы — одна выгрузка')], [2, expect.stringContaining('Строки 4, 5, 6 таблицы')]]);
    expect(draft.warnings.some((warning) => warning.code === 'SAME_PLACE_TERMIN_CONFLICT')).toBe(false);
  });

  it('reads «04:00 bis 4:00» as an exact time', () => {
    expect(read(dsv788548).stops[0]).toMatchObject({ appointmentLocal: '2026-11-19T04:00', appointmentWindowStartLocal: null, appointmentWindowEndLocal: null });
    expect(normalizeAiSchedule({ appointmentLocal: null, appointmentWindowStartLocal: '2026-11-19T07:00', appointmentWindowEndLocal: '2026-11-19T14:00' }))
      .toMatchObject({ appointmentLocal: null, appointmentWindowStartLocal: '2026-11-19T07:00' });
  });

  it('keeps the earlier of two different Termine and names both', () => {
    const rows: Row[] = [dsv788548[0]!, { ...dsv788548[2]!, start: '2026-11-19T12:00', end: '2026-11-19T13:00' }, dsv788548[2]!];
    const draft = read(rows);
    expect(draft.stops).toHaveLength(2);
    expect(draft.stops[1]).toMatchObject({ appointmentWindowStartLocal: '2026-11-19T07:00', appointmentWindowEndLocal: '2026-11-19T14:00' });
    expect(draft.warnings.find((warning) => warning.code === 'SAME_PLACE_TERMIN_CONFLICT')?.message).toContain('07:00–14:00');
  });

  it('merges only neighbouring rows of one type at one street, house number and postcode', () => {
    const parsdorf = dsv788548[1]!;
    expect(read([dsv788548[0]!, parsdorf, dsv788548[3]!, parsdorf]).stops).toHaveLength(4);
    expect(read([dsv788548[0]!, parsdorf, { ...parsdorf, type: 'LOAD' }]).stops).toHaveLength(3);
    expect(read([dsv788548[0]!, parsdorf, { ...parsdorf, address: 'Am Gewerbepark 3, 85599 Parsdorf' }]).stops).toHaveLength(3);
    expect(read([dsv788548[0]!, { ...parsdorf, address: 'Parsdorf' }, { ...parsdorf, address: 'Parsdorf' }]).stops).toHaveLength(3);
  });

  it('leaves DSV 788770 with two different places as it is', () => {
    const draft = read([
      { type: 'LOAD', company: 'BMW 2.4 DINGOLFING', address: 'KARL-DOMPERT-STR. 9, 84130 Dingolfing', city: 'Dingolfing', start: '2026-11-18T19:55', end: '2026-11-18T19:55', refs: ['24001773159'] },
      { type: 'UNLOAD', company: 'BBP Kunststoffwerk', address: 'Erdmannhäuser Str. 59, 71672 Marbach', city: 'Marbach' }
    ]);
    expect(draft.stops.map((stop) => stop.city)).toEqual(['Dingolfing', 'Marbach']);
    expect(draft.stops[0]!.appointmentLocal).toBe('2026-11-18T19:55');
    expect(draft.warnings.some((warning) => warning.code.startsWith('SAME_PLACE'))).toBe(false);
  });
});
