import { describe, expect, it } from 'vitest';
import { buildStatusRow, cityOf, dayStartOf, estimateStart, latestStartForTermin, presentRow, statusTime, STATUS_TEXT_DE, type StatusInput } from '../src/services/daily-status.js';
import type { PlannerStop } from '../src/services/termin-planner.js';
import type { DriverHours, WebfleetDrivingTimes } from '../src/services/webfleet-live.js';

// 05.11.2026 is winter time: Berlin = UTC+1, 07:00 Berlin = 06:00Z.
const DAY = '2026-11-05';
const now = new Date('2026-11-05T06:00:00Z');
const H = 3600;
const vehicle = { id: 'v1', vehicleNumber: '720', licensePlate: null };

const stop = (overrides: Partial<PlannerStop> = {}): PlannerStop => ({
  stopId: 's1', tourId: 't1', label: 'Werk', type: 'UNLOAD', driveSeconds: 3 * H, serviceMinMinutes: 60, serviceMaxMinutes: 120,
  appointmentAt: null, appointmentWindowStartAt: null, appointmentWindowEndAt: null, terminRequired: false, arrivedAt: null, ...overrides
});
const times = (overrides: Partial<WebfleetDrivingTimes> = {}): WebfleetDrivingTimes => ({
  driverUid: 'd1', name: null, referenceTime: '2026-11-05T05:55:00Z', remainDrivingTodayMs: 7 * H * 1000, totalDrivingTodayMs: H * 1000, totalOtherWorkTodayMs: 0,
  totalAvailabilityTodayMs: 0, maxDrivingTodayMs: 9 * H * 1000, remainDrivingWeekMs: null, maxDrivingWeekMs: null, shiftStartedAt: '2026-11-05T05:08:00Z',
  latestShiftEndAt: '2026-11-05T18:08:00Z', nextBreakAt: null, nextBreakMinMs: null, nextRestAt: '2026-11-05T18:08:00Z', nextRestMinMs: null, earliestNextShiftAt: null,
  extendedShiftsUsed: null, maxExtendedShifts: null, reducedRestsUsed: null, maxReducedRests: null, restBalances: [], infringements: false, lastCardActivityAt: null, ...overrides
});
const hours = (overrides: Partial<DriverHours> = {}): DriverHours => ({ status: 'SIGNED_ON', workState: 5, activitySince: '2026-11-05T05:10:00Z', times: times(), timesStatus: 'OK', ...overrides });

describe('town from a Webfleet address', () => {
  it.each([
    ['Musterstr. 1, 37083 Göttingen, DE', 'Göttingen'],
    ['A7, Göttingen', 'Göttingen'],
    ['VW Emden (VW-LKW-Tor), 26723 Emden, DE', 'Emden'],
    ['D-08056 Zwickau', 'Zwickau'],
    ['Industriestraße 4, Schlüsselfeld', 'Schlüsselfeld'],
    ['A7', null],
    [null, null]
  ])('%s → %s', (address, city) => expect(cityOf(address)).toBe(city));
});

describe('latest start for a Termin', () => {
  const termin = '2026-11-05T10:30:00Z'; // 11:30 Berlin, deadline 11:00 with the 30-minute buffer
  it('3 h drive to an 11:30 Termin: leave at 08:00', () => {
    expect(latestStartForTermin([stop({ appointmentAt: termin })], 0, new Date(termin), new Date('2026-11-05T05:00:00Z'), vehicle, null))
      .toEqual({ status: 'OK', latestStart: new Date('2026-11-05T07:00:00Z') });
  });
  it('5 h drive needs the 45-minute break: leave at 05:15', () => {
    expect(latestStartForTermin([stop({ driveSeconds: 5 * H, appointmentAt: termin })], 0, new Date(termin), new Date('2026-11-05T03:00:00Z'), vehicle, null))
      .toEqual({ status: 'OK', latestStart: new Date('2026-11-05T04:15:00Z') });
  });
  it('counts an unloading on the way', () => {
    const stops = [stop({ stopId: 'a', driveSeconds: H }), stop({ stopId: 'b', driveSeconds: H, appointmentAt: termin })];
    // 1 h drive + 60 min unloading + 1 h drive = 3 h → 08:00 Berlin.
    expect(latestStartForTermin(stops, 1, new Date(termin), new Date('2026-11-05T04:00:00Z'), vehicle, null)).toEqual({ status: 'OK', latestStart: new Date('2026-11-05T07:00:00Z') });
  });
  it('reports a Termin that cannot be reached even from the earliest start', () => {
    const result = latestStartForTermin([stop({ driveSeconds: 12 * H, appointmentAt: termin })], 0, new Date(termin), new Date('2026-11-05T05:00:00Z'), vehicle, null);
    expect(result.status).toBe('TOO_LATE');
  });
  it('a truck already at the stop may start as late as the deadline; an unknown route says so', () => {
    expect(latestStartForTermin([stop({ arrivedAt: '2026-11-05T05:30:00Z', appointmentAt: termin })], 0, new Date(termin), new Date('2026-11-05T06:00:00Z'), vehicle, null))
      .toEqual({ status: 'OK', latestStart: new Date('2026-11-05T10:00:00Z') });
    expect(latestStartForTermin([stop({ driveSeconds: null, appointmentAt: termin })], 0, new Date(termin), new Date('2026-11-05T05:00:00Z'), vehicle, null)).toEqual({ status: 'UNKNOWN' });
  });
});

describe('today\'s start', () => {
  it('takes the real shift start from the tachograph when the driver works', () => {
    expect(estimateStart({ now, dayKey: DAY, hours: hours(), stops: [stop()], vehicle })).toEqual({ at: new Date('2026-11-05T05:08:00Z'), kind: 'TACHO' });
  });
  it('a driver still in daily rest gets an estimate after the rest, never before now', () => {
    const resting = hours({ workState: 1, times: times({ remainDrivingTodayMs: 0, shiftStartedAt: '2026-11-04T05:00:00Z', earliestNextShiftAt: '2026-11-05T04:30:00Z' }) });
    expect(estimateStart({ now, dayKey: DAY, hours: resting, stops: [stop()], vehicle })).toEqual({ at: now, kind: 'AFTER_REST' });
    expect(estimateStart({ now: new Date('2026-11-05T03:00:00Z'), dayKey: DAY, hours: resting, stops: [stop()], vehicle }))
      .toEqual({ at: new Date('2026-11-05T04:30:00Z'), kind: 'AFTER_REST' });
  });
  it('without Webfleet: 06:00 or the generation time; with a Termin the latest start', () => {
    const none = hours({ status: 'NO_WEBFLEET', workState: null, activitySince: null, times: null, timesStatus: 'NO_DATA' });
    expect(estimateStart({ now: new Date('2026-11-05T04:30:00Z'), dayKey: DAY, hours: none, stops: [stop()], vehicle })).toEqual({ at: new Date('2026-11-05T05:00:00Z'), kind: 'DEFAULT' });
    expect(estimateStart({ now, dayKey: DAY, hours: none, stops: [stop({ appointmentAt: '2026-11-05T13:00:00Z' })], vehicle }))
      .toEqual({ at: new Date('2026-11-05T09:30:00Z'), kind: 'TERMIN_LATEST', terminFeasible: true });
  });
});

describe('status row rules', () => {
  const dayStart = dayStartOf(DAY);
  const base = (overrides: Partial<StatusInput> = {}): StatusInput => ({
    dayKey: DAY, dayStart,
    vehicle: { id: 'v1', vehicleNumber: '9724', statusGroup: 'NORD', servicePhone: '+49 1575 8235111', aSchild: false, appSped: true, currentTrailerPlate: null },
    tours: [], place: { city: 'Emden', source: 'WEBFLEET' }, start: { at: new Date('2026-11-05T05:08:00Z'), kind: 'TACHO' }, nextEta: null, coupledTrailerNo: null, ...overrides
  });
  const tour = (stops: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) => ({ id: 't1', status: 'ACTIVE', trailerPlate: null,
    stops: stops.map((item, index) => ({ id: `s${index}`, type: 'UNLOAD', city: 'Emden', address: 'Werk, 26723 Emden', arrivedAt: null, completedAt: null, appointmentAt: null, ...item })), ...overrides });

  it('arrived yesterday without ENTLADEN: says so, Ort and Ziel are the stop', () => {
    const row = buildStatusRow(base({ tours: [tour([{ arrivedAt: new Date('2026-11-04T17:40:00Z') }])] }));
    expect(row).toMatchObject({ rule: 'STUCK', ort: 'Emden', ziel: 'Emden', ankunftKind: 'ARRIVED', bemerkungAuto: STATUS_TEXT_DE.STUCK_UNLOAD_YESTERDAY });
    expect(buildStatusRow(base({ tours: [tour([{ type: 'LOAD', arrivedAt: new Date('2026-11-04T17:40:00Z') }])] })).bemerkungAuto).toBe(STATUS_TEXT_DE.STUCK_LOAD_YESTERDAY);
    expect(buildStatusRow(base({ tours: [tour([{ arrivedAt: new Date('2026-11-03T12:00:00Z') }])] })).bemerkungAuto).toBe('Fahrzeug steht seit dem 03.11. und konnte noch nicht entladen werden');
  });
  it('empty without a next tour: only the place and "leer"', () => {
    expect(buildStatusRow(base({ place: { city: 'Ingolstadt', source: 'WEBFLEET' } }))).toMatchObject({
      rule: 'EMPTY', ort: 'Ingolstadt', startAt: null, ziel: null, ankunftAt: null, bemerkungAuto: 'Fahrzeug ist leer' });
    expect(buildStatusRow(base({ place: { city: null, source: 'NONE' } })).flags).toContain('NO_GPS');
  });
  it('standing at a stop since today', () => {
    expect(buildStatusRow(base({ tours: [tour([{ type: 'LOAD', arrivedAt: new Date('2026-11-05T05:40:00Z') }])] }))).toMatchObject({ rule: 'AT_STOP', bemerkungAuto: STATUS_TEXT_DE.AT_LOAD });
  });
  it('on the way: Termin as Ankunft, ETA otherwise, and a late ETA is flagged in German', () => {
    const withTermin = buildStatusRow(base({ tours: [tour([{ city: 'München', appointmentAt: new Date('2026-11-05T10:30:00Z') }])], place: { city: 'Schlüsselfeld', source: 'WEBFLEET' }, nextEta: new Date('2026-11-05T09:50:00Z') }));
    expect(withTermin).toMatchObject({ rule: 'EN_ROUTE', ort: 'Schlüsselfeld', ziel: 'München', ankunftKind: 'TERMIN', ankunftAt: new Date('2026-11-05T10:30:00Z'), bemerkungAuto: null });
    const late = buildStatusRow(base({ tours: [tour([{ city: 'München', appointmentAt: new Date('2026-11-05T10:30:00Z') }])], nextEta: new Date('2026-11-05T11:40:00Z') }));
    expect(late.bemerkungAuto).toBe('Ankunft voraussichtlich ca. 12:40 – Termin 11:30 gefährdet');
    expect(buildStatusRow(base({ tours: [tour([{ city: 'Elterlein' }])], nextEta: new Date('2026-11-05T11:00:00Z') }))).toMatchObject({ ankunftKind: 'ETA', ziel: 'Elterlein' });
  });
  it('trailer from the tour, then the truck, then the Webfleet coupling; a queued tour gives Ziel', () => {
    expect(buildStatusRow(base({ tours: [tour([{}], { trailerPlate: 'Z-S3280' })], coupledTrailerNo: '81' })).trailer).toBe('Z-S3280');
    expect(buildStatusRow(base({ vehicle: { ...base().vehicle, currentTrailerPlate: 'GÖ-T12' }, tours: [tour([{}])], coupledTrailerNo: '81' })).trailerSource).toBe('VEHICLE');
    expect(buildStatusRow(base({ tours: [tour([{}])], coupledTrailerNo: '81' }))).toMatchObject({ trailer: '81', trailerSource: 'WEBFLEET_COUPLING' });
    const queued = buildStatusRow(base({ tours: [tour([{ city: 'Wolfsburg' }], { status: 'QUEUED', id: 'q1' })] }));
    expect(queued).toMatchObject({ rule: 'EN_ROUTE', ziel: 'Wolfsburg', tourId: 'q1' });
  });
});

describe('shown values', () => {
  it('marks estimates with "~", shows other days with the date, and lets manual values win', () => {
    const row = { ort: 'Emden', startAt: new Date('2026-11-05T05:45:00Z'), startKind: 'TERMIN_LATEST', ziel: 'München', ankunftAt: new Date('2026-11-06T10:30:00Z'), ankunftKind: 'ETA',
      bemerkungAuto: 'Fahrzeug ist leer', bemerkung: null, trailer: null, overridesJson: null };
    expect(presentRow(row, DAY)).toEqual({ ort: 'Emden', start: '~06:45', ziel: 'München', ankunft: '~06.11. 11:30', bemerkung: 'Fahrzeug ist leer', trailer: '' });
    expect(presentRow({ ...row, startKind: 'TACHO', ankunftKind: 'TERMIN', bemerkung: 'Wartet auf Papiere', overridesJson: JSON.stringify({ ziel: 'Garching' }) }, DAY))
      .toMatchObject({ start: '06:45', ankunft: '06.11. 11:30', ziel: 'Garching', bemerkung: 'Wartet auf Papiere' });
    expect(statusTime(null, DAY)).toBe('');
  });
});
