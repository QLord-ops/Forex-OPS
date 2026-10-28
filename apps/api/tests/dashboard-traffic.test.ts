import { describe, expect, it } from "vitest";
import { withoutPositionGeometry, type CurrentPosition } from "../src/domain.js";
import { toDashboardTourSummary, type TourAggregate } from "../src/services/tours.js";

describe("dashboard traffic contract", () => {
  it("keeps dispatcher stop data without retransmitting route geometry and history", () => {
    const tour = {
      id: "tour-1",
      vehicleId: "vehicle-1",
      orderNumber: "A-100",
      status: "ACTIVE",
      planVersion: 4,
      createdAt: new Date("2026-10-28T08:00:00.000Z"),
      updatedAt: new Date("2026-10-28T09:00:00.000Z"),
      vehicle: { id: "vehicle-1", vehicleNumber: "125" },
      stops: [{
        id: "stop-1",
        tourId: "tour-1",
        sequence: 1,
        type: "LOAD",
        address: "Musterstrasse 1, Berlin",
        city: "Berlin",
        latitude: 52.52,
        longitude: 13.405,
        createdAt: new Date("2026-10-28T08:00:00.000Z")
      }],
      legs: [{ id: "leg-1", routeGeometry: JSON.stringify(Array.from({ length: 2_000 }, (_, index) => [index, index])) }],
      events: [{ id: "event-1", note: "internal history" }],
      alerts: [{ id: "alert-1", type: "ONE_HOUR" }]
    } as unknown as TourAggregate;

    const summary = toDashboardTourSummary(tour);

    expect(summary).toMatchObject({
      id: "tour-1",
      vehicleId: "vehicle-1",
      orderNumber: "A-100",
      status: "ACTIVE",
      planVersion: 4,
      createdAt: "2026-10-28T08:00:00.000Z",
      updatedAt: "2026-10-28T09:00:00.000Z",
      stops: [{ id: "stop-1", address: "Musterstrasse 1, Berlin", city: "Berlin" }]
    });
    expect(summary).not.toHaveProperty("vehicle");
    expect(summary).not.toHaveProperty("legs");
    expect(summary).not.toHaveProperty("events");
    expect(summary).not.toHaveProperty("alerts");
    expect(JSON.stringify(summary)).not.toContain("routeGeometry");
  });

  it("omits unchanged route arrays from frequent position summaries", () => {
    const geometry = Array.from({ length: 2_000 }, (_, index) => [index, index] as [number, number]);
    const position = {
      vehicleId: "vehicle-1",
      geometryVersion: "route-v4",
      coordinate: [10, 50],
      routeGeometry: geometry,
      travelledGeometry: geometry.slice(0, 1_000),
      remainingGeometry: geometry.slice(999)
    } as unknown as CurrentPosition;

    const summary = withoutPositionGeometry(position);

    expect(summary).toMatchObject({ geometryVersion: "route-v4", coordinate: [10, 50] });
    expect(summary).not.toHaveProperty("routeGeometry");
    expect(summary).not.toHaveProperty("travelledGeometry");
    expect(summary).not.toHaveProperty("remainingGeometry");
  });
});
