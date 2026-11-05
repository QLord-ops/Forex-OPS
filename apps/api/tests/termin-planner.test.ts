import { describe, expect, it } from 'vitest';
import { driverBudgetFromWebfleet, evaluateCandidate, planTermin, recommendTermin, roundUpToQuarter, type DriverBudget, type PlannerStop } from '../src/services/termin-planner.js';
import { createInitialClockState } from '../src/services/vehicle-clock.js';
import type { WebfleetDrivingTimes } from '../src/services/webfleet-live.js';

const now = new Date('2026-11-05T08:00:00Z');
const H = 3600;
const times = (overrides: Partial<WebfleetDrivingTimes> = {}): WebfleetDrivingTimes => ({
  driverUid: 'd1', name: null, referenceTime: '2026-11-05T07:58:00Z',
  remainDrivingTodayMs: 6 * H * 1000, totalDrivingTodayMs: 3 * H * 1000, totalOtherWorkTodayMs: 0, totalAvailabilityTodayMs: 0, maxDrivingTodayMs: 9 * H * 1000,
  remainDrivingWeekMs: 40 * H * 1000, maxDrivingWeekMs: 56 * H * 1000, shiftStartedAt: '2026-11-05T04:00:00Z', latestShiftEndAt: '2026-11-05T17:00:00Z',
  nextBreakAt: '2026-11-05T08:58:00Z', nextBreakMinMs: 45 * 60_000, nextRestAt: '2026-11-05T17:00:00Z', nextRestMinMs: 11 * H * 1000, earliestNextShiftAt: null,
  extendedShiftsUsed: 0, maxExtendedShifts: 2, reducedRestsUsed: 1, maxReducedRests: 3, restBalances: [], infringements: false, lastCardActivityAt: null,
  ...overrides
});
const budget = (overrides: Partial<DriverBudget> = {}): DriverBudget => ({
  referenceTime: '2026-11-05T07:58:00Z', workState: 3, activitySince: null,
  continuousDriveLeftSeconds: 1 * H, breakSeconds: 45 * 60, dailyDriveLeftSeconds: 6 * H, drivenTodaySeconds: 3 * H, maxDailyDriveSeconds: 9 * H,
  shiftEndAt: '2026-11-05T17:00:00Z', restLatestAt: '2026-11-05T17:00:00Z', restSeconds: 11 * H,
  weeklyDriveLeftSeconds: 40 * H, extendedShiftsLeft: 2, reducedRestsLeft: 2, earliestNextShiftAt: null, breakRemainingSeconds: 0,
  ...overrides
});
const stop = (id: string, driveSeconds: number | null, overrides: Partial<PlannerStop> = {}): PlannerStop => ({
  stopId: id, tourId: 't1', label: id, type: 'UNLOAD', driveSeconds, serviceMinMinutes: 60, serviceMaxMinutes: 120,
  appointmentAt: null, appointmentWindowStartAt: null, appointmentWindowEndAt: null, terminRequired: false, arrivedAt: null, ...overrides
});
const vehicle = { id: 'v1', vehicleNumber: '321', licensePlate: 'GÖ-FX321' };
const start = { label: 'Позиция машины', address: null, positionSource: 'WEBFLEET' as const, stale: false };
const plan = (stops: PlannerStop[], driver: DriverBudget | null, extra: Partial<Parameters<typeof planTermin>[0]> = {}) =>
  planTermin({ now, startAt: now, stops, targetIndex: stops.length - 1, driver, clock: null, vehicle, start, ...extra });
const types = (result: ReturnType<typeof planTermin>) => result.timeline.map(s => `${s.type}:${s.durationSeconds / 60}`);

describe('driver budget from the Webfleet tachograph', () => {
  it('reads remaining driving until the break and today from the reference time', () => {
    const result = driverBudgetFromWebfleet(times(), { workState: 3, since: null }, now)!;
    expect(result.continuousDriveLeftSeconds).toBe(1 * H);
    expect(result.dailyDriveLeftSeconds).toBe(6 * H);
    expect(result.extendedShiftsLeft).toBe(2);
    expect(result.reducedRestsLeft).toBe(2);
    expect(result.shiftEndAt).toBe('2026-11-05T17:00:00Z');
  });
  it('subtracts the minutes driven since the report only while the driver is at the wheel', () => {
    const driving = driverBudgetFromWebfleet(times(), { workState: 5, since: '2026-11-05T07:00:00Z' }, now)!;
    expect(driving.continuousDriveLeftSeconds).toBe(1 * H - 120);
    expect(driving.dailyDriveLeftSeconds).toBe(6 * H - 120);
    expect(driving.drivenTodaySeconds).toBe(3 * H + 120);
    const standing = driverBudgetFromWebfleet(times(), { workState: 2, since: '2026-11-05T07:55:00Z' }, now)!;
    expect(standing.continuousDriveLeftSeconds).toBe(1 * H);
  });
  it('finishes a break that already counts on the tachograph and then has a full 4 h 30', () => {
    const result = driverBudgetFromWebfleet(times(), { workState: 2, since: '2026-11-05T07:40:00Z' }, now)!;
    expect(result.breakRemainingSeconds).toBe(25 * 60);
    expect(result.continuousDriveLeftSeconds).toBe(4.5 * H);
  });
  it('is unusable when the report is older than an hour or has no reference time', () => {
    expect(driverBudgetFromWebfleet(times({ referenceTime: '2026-11-05T06:30:00Z' }), null, now)).toBeNull();
    expect(driverBudgetFromWebfleet(times({ referenceTime: null }), null, now)).toBeNull();
  });
});

describe('Termin planner on tachograph budgets', () => {
  it('inserts the 45-minute break where the continuous driving runs out', () => {
    const result = plan([stop('A', 3 * H)], budget());
    expect(types(result)).toEqual(['DRIVE:60', 'BREAK:45', 'DRIVE:120']);
    expect(result.stops[0]!.earliestArrival).toBe('2026-11-05T11:45:00.000Z');
    expect(result.recommendation.terminAt).toBe('2026-11-05T12:15:00.000Z');
    expect(result.recommendation.afterDailyRest).toBe(false);
    expect(result.source).toBe('WEBFLEET');
    expect(result.preliminary).toBe(false);
  });
  it('takes a 30-minute second part of a split break first, then 45 minutes again', () => {
    const result = plan([stop('A', 7 * H)], budget({ breakSeconds: 30 * 60, dailyDriveLeftSeconds: 9 * H, shiftEndAt: null, restLatestAt: null }));
    expect(types(result)).toEqual(['DRIVE:60', 'BREAK:30', 'DRIVE:270', 'BREAK:45', 'DRIVE:90']);
  });
  it('puts the daily rest before the stop and recommends the morning after it', () => {
    const result = plan([stop('A', 3 * H)], budget({ dailyDriveLeftSeconds: 1 * H, continuousDriveLeftSeconds: 2 * H }));
    expect(types(result)).toEqual(['DRIVE:60', 'DAILY_REST:660', 'DRIVE:120']);
    expect(result.recommendation.afterDailyRest).toBe(true);
    expect(result.recommendation.restEndsAt).toBe('2026-11-05T20:00:00.000Z');
    expect(result.recommendation.terminAt).toBe('2026-11-05T22:30:00.000Z');
    expect(result.recommendation.terminAtLocal).toBe('23:30');
    expect(result.candidates.find(c => c.label === 'С запасом +1 ч')!.atLocal).toBe('06.11, 00:30');
    expect(result.notes.some(note => note.includes('9 ч вождения'))).toBe(true);
    expect(result.candidates.map(c => c.label)).toContain('С сокращённым отдыхом 9 ч');
    expect(result.candidates.find(c => c.label === 'С сокращённым отдыхом 9 ч')!.at).toBe('2026-11-05T20:30:00.000Z');
  });
  it('rests when the shift window ends before the driving budget', () => {
    const result = plan([stop('A', 2 * H)], budget({ continuousDriveLeftSeconds: 4 * H, shiftEndAt: '2026-11-05T08:30:00Z', restLatestAt: '2026-11-05T08:30:00Z' }));
    expect(types(result)).toEqual(['DRIVE:30', 'DAILY_REST:660', 'DRIVE:90']);
  });
  it('counts a stay of 45 minutes or more at a stop as the break; a short visit does not', () => {
    const loaded = plan([stop('A', 1 * H), stop('B', 3 * H)], budget({ continuousDriveLeftSeconds: 1.5 * H }));
    expect(types(loaded)).toEqual(['DRIVE:60', 'SERVICE:60', 'DRIVE:180']);
    expect(loaded.notes.some(note => note.includes('засчитана как перерыв'))).toBe(true);
    const visited = plan([stop('A', 1 * H, { type: 'VISIT', serviceMinMinutes: 0, serviceMaxMinutes: 0 }), stop('B', 3 * H)], budget({ continuousDriveLeftSeconds: 1.5 * H }));
    expect(types(visited)).toEqual(['DRIVE:60', 'DRIVE:30', 'BREAK:45', 'DRIVE:150']);
  });
  it('counts waiting for a next-morning Termin as the daily rest', () => {
    const result = plan([stop('A', 1 * H, { appointmentAt: '2026-11-05T21:00:00Z' }), stop('B', 8 * H)], budget({ dailyDriveLeftSeconds: 2 * H, shiftEndAt: null, restLatestAt: null }));
    expect(types(result).slice(0, 3)).toEqual(['DRIVE:60', 'WAIT:720', 'SERVICE:60']);
    expect(types(result).filter(t => t.startsWith('DAILY_REST'))).toEqual([]);
    expect(types(result).filter(t => t.startsWith('BREAK'))).toHaveLength(1);
  });
  it('offers the 9-hour rest only while reduced rests remain', () => {
    const result = plan([stop('A', 3 * H)], budget({ dailyDriveLeftSeconds: 1 * H, reducedRestsLeft: 0 }));
    expect(result.candidates.map(c => c.label)).not.toContain('С сокращённым отдыхом 9 ч');
    expect(types(result)).toContain('DAILY_REST:660');
  });
  it('warns about the weekly limit without changing the arrival', () => {
    const result = plan([stop('A', 3 * H)], budget({ weeklyDriveLeftSeconds: 2 * H }));
    expect(result.warnings.some(w => w.includes('Недельный лимит'))).toBe(true);
    expect(result.stops[0]!.earliestArrival).toBe('2026-11-05T11:45:00.000Z');
  });
  it('judges an existing Termin against the earliest and latest arrival', () => {
    const late = plan([stop('A', 1 * H), stop('B', 1 * H, { appointmentAt: '2026-11-05T10:30:00Z' })], budget({ continuousDriveLeftSeconds: 4 * H }));
    expect(late.stops[1]).toMatchObject({ earliestArrival: '2026-11-05T11:00:00.000Z', latestArrival: '2026-11-05T12:00:00.000Z', verdict: 'LATE' });
    expect(late.candidates.find(c => c.label === 'Текущий Termin')).toMatchObject({ verdict: 'LATE', deltaMinutes: 30 });
    expect(late.candidates.find(c => c.label === 'Рекомендуемый')).toMatchObject({ at: '2026-11-05T11:30:00.000Z', verdict: 'RISK' });
    expect(late.candidates.find(c => c.label === 'С запасом +1 ч')).toMatchObject({ at: '2026-11-05T12:30:00.000Z', verdict: 'OK' });
  });
  it('answers «если Termin в …» as a candidate', () => {
    const result = plan([stop('A', 3 * H)], budget(), { candidateAt: new Date('2026-11-05T13:00:00Z') });
    expect(result.candidates.find(c => c.label === 'По запросу')).toMatchObject({ verdict: 'OK', deltaMinutes: 75 });
  });
  it('falls back to the calculated clock when there is no tachograph data', () => {
    const clock = createInitialClockState({ effectiveAt: now, drivingSeconds: 9 * H, dutySeconds: 9 * H, continuousDrivingSeconds: 0 });
    const result = plan([stop('A', 2 * H)], null, { clock });
    expect(result.source).toBe('CALCULATED');
    expect(result.preliminary).toBe(true);
    expect(result.timeline.map(s => s.type)).toEqual(['DAILY_REST', 'DRIVE']);
    expect(result.warnings.some(w => w.includes('Нет данных тахографа'))).toBe(true);
    expect(result.driver).toMatchObject({ source: 'CALCULATED', preliminary: false });
  });
  it('leaves arrival unknown after a stop without a route', () => {
    const result = plan([stop('A', 1 * H), stop('B', null), stop('C', 1 * H)], budget());
    expect(result.stops.map(s => s.earliestArrival)).toEqual(['2026-11-05T09:00:00.000Z', null, null]);
    expect(result.recommendation.terminAt).toBeNull();
    expect(result.preliminary).toBe(true);
    expect(result.candidates).toEqual([]);
  });
});

describe('Termin rounding', () => {
  it('rounds up to the quarter hour after the 30-minute buffer', () => {
    expect(recommendTermin(new Date('2026-11-05T13:02:00Z')).toISOString()).toBe('2026-11-05T13:45:00.000Z');
    expect(recommendTermin(new Date('2026-11-05T13:00:00Z')).toISOString()).toBe('2026-11-05T13:30:00.000Z');
    expect(recommendTermin(new Date('2026-11-05T13:31:00Z')).toISOString()).toBe('2026-11-05T14:15:00.000Z');
    expect(roundUpToQuarter(new Date('2026-11-05T13:45:00Z')).toISOString()).toBe('2026-11-05T13:45:00.000Z');
  });
  it('classifies a candidate against the arrival range', () => {
    const earliest = new Date('2026-11-05T10:00:00Z'), latest = new Date('2026-11-05T11:00:00Z');
    expect(evaluateCandidate(new Date('2026-11-05T09:30:00Z'), earliest, latest)).toEqual({ verdict: 'LATE', deltaMinutes: 30 });
    expect(evaluateCandidate(new Date('2026-11-05T10:20:00Z'), earliest, latest)).toEqual({ verdict: 'RISK', deltaMinutes: 40 });
    expect(evaluateCandidate(new Date('2026-11-05T11:30:00Z'), earliest, latest)).toEqual({ verdict: 'OK', deltaMinutes: 90 });
  });
});
