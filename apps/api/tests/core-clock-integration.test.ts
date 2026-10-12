import { describe, expect, it } from "vitest";
import { createInitialClockState } from "../src/services/vehicle-clock.js";
import { makePersistedDrivePlan, snapshotVehicleClock } from "../src/services/tours.js";
import { EtaService } from "../src/services/eta.js";

const start = new Date("2026-10-11T06:00:00Z");
const at = (hours: number) => new Date(start.getTime() + hours * 3600_000);
const clock = () => createInitialClockState({ effectiveAt: start });
const leg = (hours: number) => ({ startedAt: start, simulatedDurationSeconds: hours * 3600, drivePlan: JSON.stringify(makePersistedDrivePlan(clock(), hours * 3600, start)) });

describe("persisted machine schedule integration", () => {
  it("freezes the marker for a break and preserves clock through JSON restart", () => {
    const route = leg(6);
    const vehicle = { clockState: JSON.stringify(clock()) };
    const first = snapshotVehicleClock(vehicle, route, at(4.1));
    expect(first.progress).toBeCloseTo(4 / 6);
    expect(first.pauseKind).toBe("BREAK");
    expect(snapshotVehicleClock(vehicle, route, at(4.6)).progress).toBe(first.progress);
    expect(first.eta?.toISOString()).toBe(at(6.75).toISOString());
    // Persisted JSON plans are self-contained; rehydrated DB timestamps stay Dates.
    expect(snapshotVehicleClock(vehicle, { ...route, drivePlan: JSON.stringify(JSON.parse(route.drivePlan)) }, at(4.1))).toEqual(first);
  });

  it("a manual stop consumes duty but neither drive nor distance", () => {
    const route = leg(6);
    const moving = snapshotVehicleClock({ clockState: JSON.stringify(clock()) }, route, at(2));
    const paused = snapshotVehicleClock({ clockState: JSON.stringify(moving.clockState), manualStoppedAt: at(2) }, route, at(5));
    expect(paused.progress).toBeCloseTo(2 / 6);
    expect(paused.clockState.currentCycle.drivingSeconds).toBe(2 * 3600);
    expect(paused.clockState.currentCycle.dutySeconds).toBe(5 * 3600);
    expect(paused.pauseKind).toBe("MANUAL_STOP");
  });

  it("keeps legacy machine hours unknown", () => {
    expect(snapshotVehicleClock({ clockState: null }, null, start).clockState.kind).toBe("UNKNOWN");
  });

  it("carries driving through a new leg and freezes during daily rest", () => {
    const exhausted = createInitialClockState({ effectiveAt: start, drivingSeconds: 9 * 3600, dutySeconds: 10.5 * 3600, continuousDrivingSeconds: 3600 });
    const route = { startedAt: start, simulatedDurationSeconds: 7200, drivePlan: JSON.stringify(makePersistedDrivePlan(exhausted, 7200, start)) };
    const resting = snapshotVehicleClock({ clockState: JSON.stringify(exhausted) }, route, at(5));
    expect(resting.progress).toBe(0);
    expect(resting.pauseKind).toBe("DAILY_REST");
    expect(resting.eta?.toISOString()).toBe(at(13).toISOString());
  });

  it("keeps no-appointment stops risk-free and propagates service interval", () => {
    const schedule = new EtaService().calculateVehicleSchedule([{
      id: "tour", status: "ACTIVE", queueIndex: 0, createdAt: start, plannedStartAt: null,
      vehicle: { clockState: JSON.stringify(clock()) },
      stops: [
        { id: "a", sequence: 1, type: "LOAD", address: "Berlin", city: "Berlin", appointmentAt: null, arrivedAt: start, completedAt: null, serviceMinMinutes: 60, serviceMaxMinutes: 120 },
        { id: "b", sequence: 2, type: "UNLOAD", address: "Hamburg", city: "Hamburg", appointmentAt: null, arrivedAt: null, completedAt: null, serviceMinMinutes: 60, serviceMaxMinutes: 120 }
      ],
      legs: [{ toStopId: "b", fromStopId: "a", status: "WAITING", startedAt: null, simulatedDurationSeconds: 3600 }]
    }] as never, start);
    expect(schedule[1].earliestArrival).toEqual(at(2));
    expect(schedule[1].latestArrival).toEqual(at(3));
    expect(schedule[1].predictedDelayMinutes).toBe(0);
    expect(schedule[1].riskColor).toBe("GREY");
  });
});
