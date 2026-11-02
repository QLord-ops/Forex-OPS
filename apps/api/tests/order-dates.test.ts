import { describe, expect, it } from 'vitest';
import { normalizeAiSchedule, parseDateAndTime, parseStopSchedule } from '../src/services/order-dates.js';

const now = new Date('2026-11-02T10:00:00Z');
const exact = (at: string) => ({ appointmentLocal: at, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null, note: null });
const win = (from: string, to: string, note: string | null = null) => ({ appointmentLocal: null, appointmentWindowStartLocal: from, appointmentWindowEndLocal: to, note });

describe('dates printed on an Auftrag', () => {
  it('reads exact appointments in German and ISO formats', () => {
    expect(parseStopSchedule('06.10.2026 14:15', now)).toEqual(exact('2026-10-06T14:15'));
    expect(parseStopSchedule('FIX 05.11.26 13.30 Uhr', now)).toEqual(exact('2026-11-05T13:30'));
    expect(parseStopSchedule('2026-11-05 08:00', now)).toEqual(exact('2026-11-05T08:00'));
    expect(parseStopSchedule('Mi, 05.11.2026, 9 Uhr', now)).toEqual(exact('2026-11-05T09:00'));
  });
  it('turns a date without a time into the 06:00–18:00 window', () => {
    expect(parseStopSchedule('Ladedatum 05.11.2026', now)).toEqual(win('2026-11-05T06:00', '2026-11-05T18:00', 'DATE_ONLY'));
    expect(parseStopSchedule('2026-11-05', now)).toEqual(win('2026-11-05T06:00', '2026-11-05T18:00', 'DATE_ONLY'));
  });
  it('reads ranges, "bis" and "ab" as windows', () => {
    expect(parseStopSchedule('05.11.2026 08:00-14:00', now)).toEqual(win('2026-11-05T08:00', '2026-11-05T14:00'));
    expect(parseStopSchedule('05.11.2026 von 8 bis 12 Uhr', now)).toEqual(win('2026-11-05T08:00', '2026-11-05T12:00'));
    expect(parseStopSchedule('05.11.2026 bis 12 Uhr', now)).toEqual(win('2026-11-05T06:00', '2026-11-05T12:00'));
    expect(parseStopSchedule('05.11.2026 bis 05:00', now)).toEqual(win('2026-11-05T00:00', '2026-11-05T05:00'));
    expect(parseStopSchedule('05.11.2026 ab 14 Uhr', now)).toEqual(win('2026-11-05T14:00', '2026-11-05T18:00'));
  });
  it('completes a missing year with the next such date', () => {
    expect(parseStopSchedule('05.11. 10:00', now)).toEqual(exact('2026-11-05T10:00'));
    expect(parseStopSchedule('10.01.', now)).toEqual(win('2027-01-10T06:00', '2027-01-10T18:00', 'DATE_ONLY'));
    expect(parseStopSchedule('20.10.', now).appointmentWindowStartLocal).toBe('2026-10-20T06:00');
  });
  it('merges separate date and time columns', () => {
    expect(parseDateAndTime('05.11.2026', '08:00 - 12:00', now)).toEqual(win('2026-11-05T08:00', '2026-11-05T12:00'));
    expect(parseDateAndTime('05.11.2026', null, now).note).toBe('DATE_ONLY');
  });
  it('reports what it cannot use instead of guessing', () => {
    expect(parseStopSchedule('KW 46', now).note).toBe('UNSUPPORTED');
    expect(parseStopSchedule('14:00', now).note).toBe('MISSING_DATE');
    expect(parseStopSchedule('31.02.2026 10:00', now).note).toBe('UNSUPPORTED');
    expect(parseStopSchedule('nach Absprache', now).note).toBe('UNSUPPORTED');
    expect(parseStopSchedule('', now)).toEqual({ appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null, note: null });
  });
  it('cleans AI answers: exact wins, date-only becomes the working-hours window', () => {
    expect(normalizeAiSchedule({ appointmentLocal: '2026-11-05T13:30', appointmentWindowStartLocal: '2026-11-05T08:00', appointmentWindowEndLocal: '2026-11-05T16:00' }))
      .toEqual(exact('2026-11-05T13:30'));
    expect(normalizeAiSchedule({ appointmentLocal: null, appointmentWindowStartLocal: null, appointmentWindowEndLocal: null, appointmentDateLocal: '2026-11-05' }))
      .toEqual(win('2026-11-05T06:00', '2026-11-05T18:00', 'DATE_ONLY'));
  });
});
