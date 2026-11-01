import { describe, expect, it } from "vitest";
import {
  applyStopTime,
  clockWarnings,
  createInitialClockState,
  createUnknownClockState,
  evaluateClockPlan,
  forecastDrive,
  getBerlinIsoWeekKey,
  releaseCycleExtension,
  reserveCycleExtension,
  resetReducedRestCounter,
  stateAt,
  validateInitialClock
} from "../src/services/vehicle-clock.js";

const hour = 3600;
const minute = 60;
const t = (iso: string) => new Date(iso);

describe("vehicle clock planner", () => {
  it("does not silently treat unknown clocks as fully rested", () => {
    const state = createUnknownClockState("2026-10-10T08:00:00.000Z");
    const result = forecastDrive(state, 2 * hour, t("2026-10-10T08:00:00.000Z"));

    expect(result.isPreliminary).toBe(true);
    expect(result.warnings).toContain("CLOCK_STATE_UNKNOWN");
    expect(result.state.kind).toBe("UNKNOWN");
    expect(result.segments).toEqual([
      {
        type: "DRIVE",
        startAt: "2026-10-10T08:00:00.000Z",
        endAt: "2026-10-10T10:00:00.000Z",
        durationSeconds: 2 * hour
      }
    ]);
  });

  it("inserts 45 minutes after 4 hours of calculated driving", () => {
    const state = createInitialClockState({
      effectiveAt: "2026-10-10T06:00:00.000Z",
      cycleId: "cycle-a"
    });

    const result = forecastDrive(state, 5 * hour, t("2026-10-10T06:00:00.000Z"));

    expect(result.endAt).toBe("2026-10-10T11:45:00.000Z");
    expect(result.segments.map((segment) => [segment.type, segment.durationSeconds])).toEqual([
      ["DRIVE", 4 * hour],
      ["BREAK", 45 * minute],
      ["DRIVE", hour]
    ]);
    expect(result.state.currentCycle.drivingSeconds).toBe(5 * hour);
    expect(result.state.currentCycle.continuousDrivingSeconds).toBe(hour);
  });

  it("persists forecast plan snapshots and restores state in the middle of movement", () => {
    const state = createInitialClockState({
      effectiveAt: "2026-10-10T06:00:00.000Z",
      cycleId: "cycle-a",
      drivingSeconds: hour,
      dutySeconds: 2 * hour,
      continuousDrivingSeconds: hour
    });

    const result = forecastDrive(state, 4 * hour, t("2026-10-10T06:00:00.000Z"));
    const evaluated = evaluateClockPlan(result.plan, t("2026-10-10T08:30:00.000Z"));

    expect(result.plan.steps[0].stateBefore.currentCycle.drivingSeconds).toBe(hour);
    expect(result.plan.steps.at(-1)?.stateAfter.updatedAt).toBe(result.endAt);
    expect(evaluated.activeSegment?.type).toBe("DRIVE");
    expect(evaluated.state.currentCycle.drivingSeconds).toBe(3.5 * hour);
    expect(evaluated.state.currentCycle.dutySeconds).toBe(4.5 * hour);
    expect(stateAt(result.plan, t("2026-10-10T09:45:00.000Z")).currentCycle.continuousDrivingSeconds).toBe(0);
  });

  it("adds daily rest at 9 hours without adding a separate 45 minute break first", () => {
    const state = createInitialClockState({
      effectiveAt: "2026-10-10T06:00:00.000Z",
      cycleId: "cycle-a",
      drivingSeconds: 9 * hour,
      dutySeconds: 11 * hour,
      continuousDrivingSeconds: 4 * hour
    });

    const result = forecastDrive(state, hour, t("2026-10-10T17:00:00.000Z"));

    expect(result.segments.map((segment) => segment.type)).toEqual(["DAILY_REST", "DRIVE"]);
    expect(result.segments[0]).toMatchObject({
      startAt: "2026-10-10T17:00:00.000Z",
      endAt: "2026-10-11T04:00:00.000Z",
      durationSeconds: 11 * hour
    });
    expect(result.endAt).toBe("2026-10-11T05:00:00.000Z");
    expect(result.state.currentCycle.drivingSeconds).toBe(hour);
  });

  it("applies 10 hour driving and 9 hour rest extensions independently", () => {
    const normal = createInitialClockState({
      effectiveAt: "2026-10-05T06:00:00.000Z",
      cycleId: "cycle-a",
      drivingSeconds: 9 * hour,
      dutySeconds: 12 * hour
    });
    const extendedDrive = reserveCycleExtension(normal, {
      type: "EXTENDED_DRIVE",
      reservationId: "drive-1",
      requestedAt: "2026-10-05T06:00:00.000Z"
    }).state;

    const driveResult = forecastDrive(extendedDrive, hour, t("2026-10-05T18:00:00.000Z"));
    expect(driveResult.segments.map((segment) => segment.type)).toEqual(["DRIVE"]);
    expect(driveResult.state.currentCycle.drivingSeconds).toBe(10 * hour);
    expect(driveResult.state.weeklyExtendedDrive.used).toBe(1);

    const reducedRestOnly = reserveCycleExtension(normal, {
      type: "REDUCED_REST",
      reservationId: "rest-1",
      requestedAt: "2026-10-05T06:00:00.000Z"
    }).state;
    const restResult = forecastDrive(reducedRestOnly, hour, t("2026-10-05T18:00:00.000Z"));
    expect(restResult.segments.map((segment) => segment.type)).toEqual(["DAILY_REST", "DRIVE"]);
    expect(restResult.segments[0].durationSeconds).toBe(9 * hour);
    expect(restResult.state.reducedRestsSinceWeeklyRest).toBe(1);
  });

  it("allows 15 hour duty windows to absorb waiting without reducing drive budget", () => {
    const state = reserveCycleExtension(
      createInitialClockState({
        effectiveAt: "2026-10-10T06:00:00.000Z",
        cycleId: "cycle-a",
        drivingSeconds: 7 * hour,
        dutySeconds: 12 * hour
      }),
      {
        type: "REDUCED_REST",
        reservationId: "rest-1",
        requestedAt: "2026-10-10T06:00:00.000Z"
      }
    ).state;

    const waited = applyStopTime(state, 2 * hour, t("2026-10-10T18:00:00.000Z"));
    expect(waited.state.currentCycle.dutySeconds).toBe(14 * hour);
    expect(waited.state.currentCycle.drivingSeconds).toBe(7 * hour);

    const result = forecastDrive(waited.state, hour, t("2026-10-10T20:00:00.000Z"));
    expect(result.segments.map((segment) => segment.type)).toEqual(["DRIVE"]);
    expect(result.state.currentCycle.dutySeconds).toBe(15 * hour);
  });

  it("keeps extension reservations idempotent and enforces weekly/reduced counters", () => {
    let state = createInitialClockState({
      effectiveAt: "2026-10-05T06:00:00.000Z",
      cycleId: "cycle-a"
    });

    state = reserveCycleExtension(state, {
      type: "EXTENDED_DRIVE",
      reservationId: "drive-1",
      requestedAt: "2026-10-05T06:00:00.000Z"
    }).state;
    state = reserveCycleExtension(state, {
      type: "EXTENDED_DRIVE",
      reservationId: "drive-1",
      requestedAt: "2026-10-05T06:00:00.000Z"
    }).state;
    expect(state.weeklyExtendedDrive.used).toBe(1);

    const released = releaseCycleExtension(state, {
      type: "EXTENDED_DRIVE",
      reservationId: "drive-1"
    }).state;
    expect(released.weeklyExtendedDrive.used).toBe(0);

    const almostSpent = reserveCycleExtension(
      createInitialClockState({
        effectiveAt: "2026-10-05T06:00:00.000Z",
        cycleId: "cycle-spent",
        drivingSeconds: 9 * hour,
        dutySeconds: 9 * hour
      }),
      {
        type: "EXTENDED_DRIVE",
        reservationId: "drive-1",
        requestedAt: "2026-10-05T06:00:00.000Z"
      }
    ).state;
    const usedExtension = forecastDrive(almostSpent, hour, t("2026-10-05T15:00:00.000Z")).state;
    const rejectedRelease = releaseCycleExtension(usedExtension, {
      type: "EXTENDED_DRIVE",
      reservationId: "drive-1"
    });
    expect(rejectedRelease.accepted).toBe(false);
    expect(rejectedRelease.reason).toBe("ALREADY_STARTED");

    let restState = state;
    for (const id of ["rest-1", "rest-2", "rest-3"]) {
      restState = reserveCycleExtension(restState, {
        type: "REDUCED_REST",
        reservationId: id,
        requestedAt: "2026-10-05T06:00:00.000Z"
      }).state;
      restState = createInitialClockState({
        effectiveAt: "2026-10-05T06:00:00.000Z",
        cycleId: id,
        reducedRestsSinceWeeklyRest: restState.reducedRestsSinceWeeklyRest
      });
    }

    expect(
      reserveCycleExtension(restState, {
        type: "REDUCED_REST",
        reservationId: "rest-4",
        requestedAt: "2026-10-05T06:00:00.000Z"
      }).accepted
    ).toBe(false);

    expect(resetReducedRestCounter(restState, "2026-10-12T06:00:00.000Z").reducedRestsSinceWeeklyRest).toBe(0);
  });

  it("resets extended driving usage on the Berlin Monday calendar week", () => {
    expect(getBerlinIsoWeekKey("2026-10-11T21:30:00.000Z")).toBe("2026-W41");
    expect(getBerlinIsoWeekKey("2026-10-11T22:30:00.000Z")).toBe("2026-W42");

    const state = createInitialClockState({
      effectiveAt: "2026-10-11T21:30:00.000Z",
      cycleId: "cycle-a"
    });
    const usedSunday = reserveCycleExtension(state, {
      type: "EXTENDED_DRIVE",
      reservationId: "drive-1",
      requestedAt: "2026-10-11T21:30:00.000Z"
    }).state;
    const usedMonday = reserveCycleExtension(
      createInitialClockState({
        effectiveAt: "2026-10-11T22:30:00.000Z",
        cycleId: "cycle-b",
        weeklyExtendedDrive: usedSunday.weeklyExtendedDrive
      }),
      {
        type: "EXTENDED_DRIVE",
        reservationId: "drive-2",
        requestedAt: "2026-10-11T22:30:00.000Z"
      }
    ).state;

    expect(usedSunday.weeklyExtendedDrive).toEqual({ weekKey: "2026-W41", used: 1 });
    expect(usedMonday.weeklyExtendedDrive).toEqual({ weekKey: "2026-W42", used: 1 });
  });

  it("validates manual initial clock values", () => {
    expect(validateInitialClock({ drivingSeconds: 10 * hour }).valid).toBe(false);
    expect(validateInitialClock({ dutySeconds: 14 * hour }).valid).toBe(false);
    expect(validateInitialClock({ drivingSeconds: -1 }).errors).toContain("DRIVING_SECONDS_NEGATIVE");
    expect(validateInitialClock({ drivingSeconds: 2 * hour, dutySeconds: 3 * hour }).valid).toBe(true);
  });

  it("rejects nonfinite and negative initialization instead of silently resetting hours", () => {
    expect(() => createInitialClockState({ effectiveAt: "2026-10-10T06:00:00Z", drivingSeconds: -1 })).toThrow();
    expect(validateInitialClock({ drivingSeconds: NaN }).valid).toBe(false);
    expect(() => forecastDrive(createUnknownClockState("2026-10-10T06:00:00Z"), -1, t("2026-10-10T06:00:00Z"))).toThrow();
  });

  it("resumes a persisted mid-break state without restarting its 45 minutes", () => {
    const initial = createInitialClockState({ effectiveAt: "2026-10-10T06:00:00Z" });
    const original = forecastDrive(initial, 5 * hour, t("2026-10-10T06:00:00Z"));
    const atBreak = evaluateClockPlan(JSON.parse(JSON.stringify(original.plan)), t("2026-10-10T10:20:00Z"));
    expect(atBreak.activeSegment?.type).toBe("BREAK");
    expect(atBreak.drivenSeconds).toBe(4 * hour);
    const resumed = forecastDrive(atBreak.state, hour, t("2026-10-10T10:20:00Z"));
    expect(resumed.endAt).toBe(original.endAt);
    expect(resumed.segments[0].durationSeconds).toBe(25 * minute);
  });

  it("keeps night rest pending across reload and does not release a started reduced rest", () => {
    const initial = reserveCycleExtension(createInitialClockState({ effectiveAt: "2026-10-10T06:00:00Z", drivingSeconds: 9 * hour, dutySeconds: 12 * hour }), { type: "REDUCED_REST", reservationId: "r", requestedAt: "2026-10-10T06:00:00Z" }).state;
    const original = forecastDrive(initial, hour, t("2026-10-10T06:00:00Z"));
    const mid = evaluateClockPlan(original.plan, t("2026-10-10T09:00:00Z"));
    expect(mid.drivenSeconds).toBe(0);
    expect(releaseCycleExtension(mid.state, { type: "REDUCED_REST", reservationId: "r" }).reason).toBe("ALREADY_STARTED");
    expect(forecastDrive(mid.state, hour, t("2026-10-10T09:00:00Z")).endAt).toBe(original.endAt);
  });

  it("calculates 9/11, 10/11, 9/9 and 10/9 independently without spending twice", () => {
    for (const extended of [false, true]) for (const reduced of [false, true]) {
      let initial = createInitialClockState({ effectiveAt: "2026-10-10T06:00:00Z", drivingSeconds: 9 * hour, dutySeconds: 11 * hour });
      if (extended) initial = reserveCycleExtension(initial, { type: "EXTENDED_DRIVE", reservationId: "d", requestedAt: initial.updatedAt }).state;
      if (reduced) initial = reserveCycleExtension(initial, { type: "REDUCED_REST", reservationId: "r", requestedAt: initial.updatedAt }).state;
      const result = forecastDrive(initial, 2 * hour, t(initial.updatedAt));
      expect(result.segments.find(s => s.type === "DAILY_REST")?.durationSeconds).toBe((reduced ? 9 : 11) * hour);
      expect(result.state.weeklyExtendedDrive.used).toBe(extended ? 1 : 0);
      expect(result.state.reducedRestsSinceWeeklyRest).toBe(reduced ? 1 : 0);
      expect(forecastDrive(initial, 2 * hour, t(initial.updatedAt)).endAt).toBe(result.endAt);
    }
  });

  it("never grants a third extended driving cycle within the calendar week", () => {
    const full = createInitialClockState({ effectiveAt: "2026-10-10T06:00:00Z", weeklyExtendedDrive: { weekKey: "2026-W41", used: 2 }, reducedRestsSinceWeeklyRest: 3 });
    expect(reserveCycleExtension(full, { type: "EXTENDED_DRIVE", reservationId: "third", requestedAt: full.updatedAt }).reason).toBe("LIMIT_REACHED");
    const monday = createInitialClockState({ effectiveAt: "2026-10-12T06:00:00Z", weeklyExtendedDrive: full.weeklyExtendedDrive, reducedRestsSinceWeeklyRest: 3 });
    expect(reserveCycleExtension(monday, { type: "EXTENDED_DRIVE", reservationId: "monday", requestedAt: monday.updatedAt }).accepted).toBe(true);
    expect(reserveCycleExtension(monday, { type: "REDUCED_REST", reservationId: "monday-rest", requestedAt: monday.updatedAt }).accepted).toBe(false);
  });

  it("keeps hours across separate routes and counts an 11 hour stop as daily rest", () => {
    const initial = createInitialClockState({ effectiveAt: "2026-10-10T06:00:00Z" });
    const first = forecastDrive(initial, 3 * hour, t(initial.updatedAt));
    const stopped = applyStopTime(first.state, 12 * hour, first.endAt);
    expect(stopped.state.currentCycle.drivingSeconds).toBe(0);
    expect(stopped.state.currentCycle.dutySeconds).toBe(0);
    expect(stopped.state.currentCycle.startedAt).toBe(stopped.state.updatedAt);
    expect(stopped.segment?.type).toBe("DAILY_REST");
    expect(stopped.warnings).toEqual([]);
    expect(stopped.state.warnings).toEqual([]);
    expect(stopped.state.reducedRestsSinceWeeklyRest).toBe(0);
    const second = forecastDrive(stopped.state, hour, t(stopped.state.updatedAt));
    expect(second.segments.map((s) => s.type)).toEqual(["DRIVE"]);
    expect(second.warnings).toEqual([]);
  });

  it("clears a pending daily rest when the stop covers it", () => {
    const initial = createInitialClockState({ effectiveAt: "2026-10-10T06:00:00Z", drivingSeconds: 9 * hour, dutySeconds: 11 * hour });
    const plan = forecastDrive(initial, hour, t(initial.updatedAt)).plan;
    const resting = evaluateClockPlan(plan, t("2026-10-10T10:00:00Z")).state;
    expect(resting.pendingRest?.type).toBe("DAILY_REST");
    const parked = applyStopTime(resting, 12 * hour, resting.updatedAt).state;
    expect(parked.pendingRest).toBeUndefined();
    expect(parked.currentCycle.dutySeconds).toBe(0);
  });

  it("counts a 9-11 hour stop as reduced daily rest only while reduced rests remain", () => {
    const tired = (reduced: number) => createInitialClockState({ effectiveAt: "2026-10-10T06:00:00Z", drivingSeconds: 8 * hour, dutySeconds: 12 * hour, reducedRestsSinceWeeklyRest: reduced });

    const reduced = applyStopTime(tired(2), 10 * hour, "2026-10-10T06:00:00Z");
    expect(reduced.segment?.type).toBe("DAILY_REST");
    expect(reduced.state.reducedRestsSinceWeeklyRest).toBe(3);
    expect(reduced.state.currentCycle).toMatchObject({ drivingSeconds: 0, dutySeconds: 0, startedAt: "2026-10-10T16:00:00.000Z" });

    const exhausted = applyStopTime(tired(3), 10 * hour, "2026-10-10T06:00:00Z");
    expect(exhausted.segment?.type).toBe("WAIT");
    expect(exhausted.state.reducedRestsSinceWeeklyRest).toBe(3);
    expect(exhausted.state.currentCycle.drivingSeconds).toBe(8 * hour);
    expect(exhausted.state.currentCycle.dutySeconds).toBe(22 * hour);
    expect(exhausted.warnings).toEqual(["DUTY_WINDOW_EXCEEDED_BY_STOP"]);
    expect(exhausted.state.warnings).toEqual([]);

    expect(applyStopTime(tired(0), 9 * hour - 1, "2026-10-10T06:00:00Z").state.reducedRestsSinceWeeklyRest).toBe(0);
  });

  it("does not spend a second reduced rest when one is already reserved, and refunds it for a full rest", () => {
    const reserved = reserveCycleExtension(createInitialClockState({ effectiveAt: "2026-10-10T06:00:00Z", drivingSeconds: 8 * hour, dutySeconds: 12 * hour, reducedRestsSinceWeeklyRest: 1 }), { type: "REDUCED_REST", reservationId: "r", requestedAt: "2026-10-10T06:00:00Z" }).state;
    expect(reserved.reducedRestsSinceWeeklyRest).toBe(2);
    expect(applyStopTime(reserved, 9 * hour, reserved.updatedAt).state.reducedRestsSinceWeeklyRest).toBe(2);
    expect(applyStopTime(reserved, 11 * hour, reserved.updatedAt).state.reducedRestsSinceWeeklyRest).toBe(1);
  });

  it("treats a stop of 45 minutes or more as a break but keeps counting the duty window", () => {
    const driven = createInitialClockState({ effectiveAt: "2026-10-10T10:00:00Z", drivingSeconds: 4 * hour, dutySeconds: 4 * hour, continuousDrivingSeconds: 4 * hour });
    const short = applyStopTime(driven, 44 * minute, driven.updatedAt).state;
    expect(short.currentCycle.continuousDrivingSeconds).toBe(4 * hour);
    const stopped = applyStopTime(driven, 45 * minute, driven.updatedAt).state;
    expect(stopped.currentCycle.continuousDrivingSeconds).toBe(0);
    expect(stopped.currentCycle.dutySeconds).toBe(4 * hour + 45 * minute);
    expect(stopped.currentCycle.drivingSeconds).toBe(4 * hour);
    const next = forecastDrive(stopped, hour, t(stopped.updatedAt));
    expect(next.segments.map((s) => s.type)).toEqual(["DRIVE"]);
  });

  it("joins a stop split across calls into one rest, but not across driving", () => {
    const driven = createInitialClockState({ effectiveAt: "2026-10-10T18:00:00Z", drivingSeconds: 8 * hour, dutySeconds: 11 * hour, continuousDrivingSeconds: 2 * hour });
    const evening = applyStopTime(driven, 5 * hour, driven.updatedAt).state;
    expect(evening.currentCycle.dutySeconds).toBe(16 * hour);
    const morning = applyStopTime(evening, 7 * hour, evening.updatedAt).state;
    expect(morning.currentCycle).toMatchObject({ drivingSeconds: 0, dutySeconds: 0, startedAt: "2026-10-11T06:00:00.000Z" });

    const split = applyStopTime(createInitialClockState({ effectiveAt: "2026-10-10T06:00:00Z" }), 30 * minute, "2026-10-10T06:00:00Z").state;
    const moved = forecastDrive(split, hour, t(split.updatedAt)).state;
    const again = applyStopTime(moved, 30 * minute, moved.updatedAt).state;
    expect(again.idleSince).toBe(moved.updatedAt);
    const longDrive = createInitialClockState({ effectiveAt: "2026-10-10T10:00:00Z", drivingSeconds: 4 * hour, dutySeconds: 4 * hour, continuousDrivingSeconds: 4 * hour });
    const firstPart = applyStopTime(longDrive, 30 * minute, longDrive.updatedAt).state;
    expect(firstPart.currentCycle.continuousDrivingSeconds).toBe(4 * hour);
    expect(applyStopTime(firstPart, 15 * minute, firstPart.updatedAt).state.currentCycle.continuousDrivingSeconds).toBe(0);
  });

  it("returns stop and unknown-clock warnings per call instead of persisting them", () => {
    const unknown = createUnknownClockState("2026-10-10T06:00:00Z");
    expect(unknown.warnings).toEqual([]);
    const forecast = forecastDrive(unknown, hour, t(unknown.updatedAt));
    expect(forecast.warnings).toEqual(["CLOCK_STATE_UNKNOWN"]);
    expect(forecast.state.warnings).toEqual([]);

    const legacy = { ...createInitialClockState({ effectiveAt: "2026-10-10T06:00:00Z" }), warnings: ["DUTY_WINDOW_EXCEEDED_BY_STOP", "CLOCK_STATE_UNKNOWN"] };
    const known = forecastDrive(legacy, hour, t(legacy.updatedAt));
    expect(known.warnings).toEqual([]);
    expect(known.state.warnings).toEqual([]);
    expect(applyStopTime(legacy, minute, legacy.updatedAt).warnings).toEqual([]);

    const overrun = applyStopTime(createInitialClockState({ effectiveAt: "2026-10-10T16:00:00Z", drivingSeconds: 6 * hour, dutySeconds: 10 * hour }), 4 * hour, "2026-10-10T16:00:00Z");
    expect(overrun.warnings).toEqual(["DUTY_WINDOW_EXCEEDED_BY_STOP"]);
    expect(overrun.state.warnings).toEqual([]);
    expect(clockWarnings(overrun.state)).toEqual(["DUTY_WINDOW_EXCEEDED_BY_STOP"]);
    expect(clockWarnings(unknown)).toEqual(["CLOCK_STATE_UNKNOWN"]);
  });
});
