import { describe, expect, it } from "vitest";
import {
  calculateDistanceTravelled,
  calculateEta,
  calculatePositionOnRoute,
  calculateProgress,
  calculateRemainingDistance,
  calculateSimulatedDuration
} from "../src/services/simulation.js";

describe("SimulationService calculations", () => {
  it("enforces the 85 km/h speed cap", () => {
    expect(calculateSimulatedDuration(170_000, 3600, 85)).toBe(7200);
    expect(calculateSimulatedDuration(170_000, 3600, 120)).toBe(7200);
    expect(calculateSimulatedDuration(170_000, 9300, 85)).toBe(9300);
    expect(calculateSimulatedDuration(0, 9300, 85)).toBe(0);
  });

  it("clamps progress for missing, negative and over-duration elapsed time", () => {
    const now = new Date("2026-09-29T10:00:00.000Z");
    expect(calculateProgress(null, now, 3600)).toBe(0);
    expect(calculateProgress(new Date("2026-09-29T11:00:00.000Z"), now, 3600)).toBe(0);
    expect(calculateProgress(new Date("2026-09-29T08:00:00.000Z"), now, 3600)).toBe(1);
    expect(calculateProgress(new Date("2026-09-29T09:30:00.000Z"), now, 3600)).toBe(0.5);
    expect(calculateProgress(new Date("2026-09-29T09:30:00.000Z"), now, 3600, now)).toBe(1);
    expect(calculateProgress(new Date("2026-09-29T09:30:00.000Z"), now, 0)).toBe(1);
  });

  it("calculates travelled and remaining distance", () => {
    expect(calculateDistanceTravelled(310_000, 0.42)).toBe(130_200);
    expect(calculateRemainingDistance(310_000, 0.42)).toBe(179_800);
  });

  it("calculates ETA from the actual leg start", () => {
    expect(calculateEta(new Date("2026-09-29T09:17:00.000Z"), 7200)?.toISOString()).toBe(
      "2026-09-29T11:17:00.000Z"
    );
  });

  it("places the marker on the polyline, not on endpoint-only status", () => {
    const position = calculatePositionOnRoute(
      [
        { latitude: 0, longitude: 0 },
        { latitude: 0, longitude: 1 },
        { latitude: 1, longitude: 1 }
      ],
      0.5
    );

    expect(position?.longitude).toBeCloseTo(1, 1);
    expect(position?.latitude).toBeCloseTo(0, 1);
  });

  it("keeps arrived vehicles at the destination", () => {
    const position = calculatePositionOnRoute(
      [
        { latitude: 51, longitude: 9 },
        { latitude: 52, longitude: 10 }
      ],
      2
    );
    expect(position).toEqual({ latitude: 52, longitude: 10 });
  });
});
