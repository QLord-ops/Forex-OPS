import { describe, expect, it, vi } from "vitest";
import { dailyRestOf, RestAtStopService } from "../src/services/rest-at-stop.js";
import type { WebfleetDrivingTimes, WebfleetLiveStore } from "../src/services/webfleet-live.js";

const now = new Date("2026-11-04T15:52:00Z");
const times = (overrides: Partial<WebfleetDrivingTimes> = {}): WebfleetDrivingTimes => ({
  driverUid: "d1", name: null, referenceTime: "2026-11-04T15:50:00Z",
  remainDrivingTodayMs: 0, totalDrivingTodayMs: 8 * 3600_000, totalOtherWorkTodayMs: 0, totalAvailabilityTodayMs: 0, maxDrivingTodayMs: 10 * 3600_000,
  remainDrivingWeekMs: null, maxDrivingWeekMs: null, shiftStartedAt: "2026-11-03T23:08:00Z", latestShiftEndAt: "2026-11-04T14:08:00Z",
  nextBreakAt: null, nextBreakMinMs: null, nextRestAt: null, nextRestMinMs: null, earliestNextShiftAt: "2026-11-04T22:46:00Z",
  extendedShiftsUsed: null, maxExtendedShifts: null, reducedRestsUsed: null, maxReducedRests: null, restBalances: [], infringements: false, lastCardActivityAt: null,
  ...overrides
});

describe("daily rest from the tachograph", () => {
  it("is daily rest when the driver rests and no driving time is left; it ends at the earliest next shift", () => {
    expect(dailyRestOf({ workState: 2, activitySince: "2026-11-04T13:46:00Z", times: times(), now }))
      .toEqual({ since: "2026-11-04T13:46:00Z", until: "2026-11-04T22:46:00Z" });
  });

  it("a 45-minute break with driving time left is not daily rest", () => {
    expect(dailyRestOf({ workState: 2, activitySince: "2026-11-04T15:30:00Z", now,
      times: times({ remainDrivingTodayMs: 3 * 3600_000, nextRestAt: "2026-11-04T20:00:00Z", latestShiftEndAt: "2026-11-04T21:00:00Z" }) })).toBeNull();
  });

  it("counts a rest longer than 3 hours, an ended shift or a due rest, and takes 9 h when Webfleet gives no next shift", () => {
    const working = { remainDrivingTodayMs: 3 * 3600_000, nextRestAt: "2026-11-04T20:00:00Z", latestShiftEndAt: "2026-11-04T21:00:00Z", earliestNextShiftAt: null };
    expect(dailyRestOf({ workState: 1, activitySince: "2026-11-04T12:00:00Z", now, times: times(working) }))
      .toEqual({ since: "2026-11-04T12:00:00Z", until: "2026-11-04T21:00:00.000Z" });
    expect(dailyRestOf({ workState: 2, activitySince: null, now, times: times({ ...working, latestShiftEndAt: "2026-11-04T15:00:00Z" }) })).toEqual({ since: null, until: null });
    expect(dailyRestOf({ workState: 2, activitySince: null, now, times: times({ ...working, nextRestAt: "2026-11-04T15:40:00Z" }) })).not.toBeNull();
  });

  it("needs a rest state and fresh tachograph data", () => {
    expect(dailyRestOf({ workState: 4, times: times(), now })).toBeNull();
    expect(dailyRestOf({ workState: null, times: times(), now })).toBeNull();
    expect(dailyRestOf({ workState: 2, times: null, now })).toBeNull();
    expect(dailyRestOf({ workState: 2, times: times({ referenceTime: "2026-11-04T14:00:00Z" }), now })).toBeNull();
  });
});

describe("daily rest at a loading or unloading point", () => {
  const stop = { id: "s1", type: "LOAD", city: "Düsseldorf", company: "Werk", address: "Str. 1", arrivedAt: new Date("2026-11-04T13:20:00Z"), completedAt: null };
  const setup = (overrides: { stop?: Partial<typeof stop>; workState?: number; binding?: boolean } = {}) => {
    const db = {
      vehicle: { findMany: vi.fn(async () => [{ id: "v1", vehicleNumber: "B-CY3010", tours: [{ stops: [{ ...stop, ...overrides.stop }] }] }]) },
      vehicleIntegration: { findMany: vi.fn(async () => overrides.binding === false ? [] : [{ vehicleId: "v1", externalId: "obj-1" }]) }
    };
    const store = {
      driverOn: () => ({ driverUid: "d1", name: null, workState: overrides.workState ?? 2 }),
      activity: () => ({ driverUid: "d1", workState: overrides.workState ?? 2, since: "2026-11-04T13:46:00Z" }),
      drivingTimes: () => times()
    } as unknown as WebfleetLiveStore;
    const publish = vi.fn(async () => undefined);
    return { service: new RestAtStopService(db as never, store, publish), publish };
  };

  it("tells the dispatcher once that loading goes on after the rest, and marks the truck", async () => {
    const { service, publish } = setup();
    await service.check(now, true);
    await service.check(new Date(now.getTime() + 120_000), true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "DAILY_REST_AT_STOP", vehicleId: "v1", stopId: "s1", dedupKey: "daily-rest:s1:2026-11-04T13:46:00Z",
      message: "LKW B-CY3010 на загрузке в Düsseldorf: водитель на суточном отдыхе с 14:46 (тахограф Webfleet). Загрузка продолжится после отдыха, не раньше 23:46."
    }));
    expect(service.restAt("v1")).toMatchObject({ stopId: "s1", stopType: "LOAD", since: "2026-11-04T13:46:00Z", until: "2026-11-04T22:46:00Z" });
  });

  it("says nothing while the driver works, before the arrival, after BELADEN or without Webfleet", async () => {
    for (const overrides of [{ workState: 4 }, { stop: { arrivedAt: null } }, { stop: { completedAt: new Date() } }, { binding: false }] as const) {
      const { service, publish } = setup(overrides as never);
      await service.check(now, true);
      expect(publish).not.toHaveBeenCalled();
      expect(service.restAt("v1")).toBeNull();
    }
  });
});
