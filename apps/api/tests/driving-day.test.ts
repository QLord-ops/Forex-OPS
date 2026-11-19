import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { RouteScenarioService } from '../src/services/route-scenario.js';
import { ClockEngine, forecastEta, forecastRoute, WebfleetEngine, type DriverBudget } from '../src/services/termin-planner.js';
import { createInitialClockState } from '../src/services/vehicle-clock.js';

/**
 * Owner, 19.11.2026: a route plans 9 h of driving a day. The 10th hour (twice a week) is taken only when a Termin is
 * missed without it, and every ETA says how much driving is left to the driver on arrival.
 */
const H = 3600;
const now = new Date('2026-11-19T08:00:00Z');
const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
// 5 h driven; Webfleet counts the day up to 10 h, so it reports 5 h left.
const budget = (overrides: Partial<DriverBudget> = {}): DriverBudget => ({
  referenceTime: now.toISOString(), workState: 3, activitySince: now.toISOString(),
  continuousDriveLeftSeconds: 4.5 * H, breakSeconds: 45 * 60, dailyDriveLeftSeconds: 5 * H, drivenTodaySeconds: 5 * H, maxDailyDriveSeconds: 10 * H,
  shiftEndAt: at(12 * H), restLatestAt: null, restSeconds: 11 * H,
  weeklyDriveLeftSeconds: 40 * H, extendedShiftsLeft: 2, reducedRestsLeft: 0, earliestNextShiftAt: null, breakRemainingSeconds: 0,
  ...overrides
});
const DRIVE = 4.5 * H;

describe('9 h of driving a day, the 10th hour only for a Termin', () => {
  it('without a Termin the day ends at 9 h even though Webfleet allows 10', () => {
    const result = forecastEta(new WebfleetEngine(budget()), DRIVE, now, null);
    // 4 h to the 9 h mark, the daily rest of 11 h, then the last 30 min.
    expect(result.endAt.toISOString()).toBe(at(4 * H + 11 * H + 0.5 * H));
    expect(result.plan).toMatchObject({ extendedDay: false, rest: { seconds: 11 * H }, driveLeftSeconds: 8.5 * H });
  });

  it('takes the 10th hour when only that keeps the Termin, and says so', () => {
    const termin = new Date(at(DRIVE + 10 * 60));
    const result = forecastEta(new WebfleetEngine(budget()), DRIVE, now, termin);
    expect(result.endAt.toISOString()).toBe(at(DRIVE));
    expect(result.plan).toMatchObject({ extendedDay: true, rest: null, driveLeftSeconds: 0.5 * H });
  });

  it('keeps 9 h when the Termin is comfortable or no 10 h day is left', () => {
    const comfortable = forecastEta(new WebfleetEngine(budget()), DRIVE, now, new Date(at(24 * H)));
    expect(comfortable.plan.extendedDay).toBe(false);
    expect(comfortable.plan.rest).not.toBeNull();
    const termin = new Date(at(DRIVE + 10 * 60));
    const used = forecastEta(new WebfleetEngine(budget({ extendedShiftsLeft: 0 })), DRIVE, now, termin);
    expect(used.plan.extendedDay).toBe(false);
    expect(used.endAt.getTime()).toBeGreaterThan(termin.getTime());
  });

  it('a 10th hour that would not save the Termin is not spent', () => {
    const termin = new Date(at(2 * H));
    const result = forecastEta(new WebfleetEngine(budget()), DRIVE, now, termin);
    expect(result.plan.extendedDay).toBe(false);
  });

  it('a driver already past 9 h today keeps what the tachograph says is left', () => {
    const result = forecastEta(new WebfleetEngine(budget({ drivenTodaySeconds: 9.5 * H, dailyDriveLeftSeconds: 0.5 * H })), H, now, null);
    expect(result.plan.rest).not.toBeNull();
    expect(result.endAt.toISOString()).toBe(at(0.5 * H + 11 * H + 0.5 * H));
  });

  it('the calculated clock also plans 9 h and takes the 10th hour only for the Termin', () => {
    const clock = () => new ClockEngine(createInitialClockState({ effectiveAt: now, drivingSeconds: 5 * H, continuousDrivingSeconds: 0, dutySeconds: 5 * H }));
    const plain = forecastEta(clock(), DRIVE, now, null);
    expect(plain.plan.extendedDay).toBe(false);
    expect(plain.plan.rest).not.toBeNull();
    const result = forecastEta(clock(), DRIVE, now, new Date(at(DRIVE + 10 * 60)));
    expect(result.endAt.toISOString()).toBe(at(DRIVE));
    expect(result.plan).toMatchObject({ extendedDay: true, driveLeftSeconds: 0.5 * H });
  });

  it('a route preview says how much driving is left at its last stop', () => {
    const result = forecastRoute(new WebfleetEngine(budget()), [H, H], [60 * 60], now);
    // 1 h, an hour at the stop (the break), 1 h: 7 h of 9 driven.
    expect(result.plan.driveLeftSeconds).toBe(2 * H);
    expect(result.plan.extendedDay).toBe(false);
  });

  it('the route builder shows the driving left at every stop and marks the 10th hour', async () => {
    const coords = { latitude: 52, longitude: 13 };
    // A driver starting a fresh day: 9 h 30 to the stop.
    const route = vi.fn().mockResolvedValue({ geometry: [coords, coords], distanceMeters: 760_000, durationSeconds: 9.5 * H, provider: 'test' });
    const routing = { calculateRoute: route, calculateMultiStopRoute: route, geocode: vi.fn().mockResolvedValue({ ...coords, label: 'A', provider: 'test' }) };
    const scenario = new RouteScenarioService({} as PrismaClient, routing as never, vi.fn(), vi.fn());
    const plain = await scenario.calculate({ originAddress: 'Göttingen', startAt: now.toISOString(), stops: [{ address: 'Zimmern', type: 'UNLOAD' }] }, now);
    expect(plain.stops[0]).toMatchObject({ extendedDay: false });
    expect(plain.stops[0].driveLeftSeconds).toBe(8.5 * H);
    // Two breaks of 45 min on the way; the Termin is ten minutes after that.
    const termin = at(9.5 * H + 90 * 60 + 10 * 60);
    const tight = await scenario.calculate({ originAddress: 'Göttingen', startAt: now.toISOString(), stops: [{ address: 'Zimmern', type: 'UNLOAD', appointmentAt: termin }] }, now);
    expect(tight.stops[0]).toMatchObject({ extendedDay: true, driveLeftSeconds: 0.5 * H });
    expect(tight.stops[0].earliestArrival).toBe(at(9.5 * H + 90 * 60));
  });
});
