import { describe, expect, it } from "vitest";

import { projectOnLine, splitAtProjection } from "../src/services/route-projection.js";

// Roughly Hannover → Bremen → Emden along latitude/longitude steps.
const line = [
  { latitude: 52.37, longitude: 9.73 },
  { latitude: 53.07, longitude: 8.8 },
  { latitude: 53.36, longitude: 7.2 }
];

describe("route projection", () => {
  it("measures the distance left from the GPS point, not from a timer", () => {
    const projection = projectOnLine(line, { latitude: 53.07, longitude: 8.8 })!;
    expect(projection.offMeters).toBeLessThan(50);
    const remaining = projection.totalMeters - projection.alongMeters;
    // Bremen → Emden is about 112 km along this line.
    expect(remaining / 1000).toBeGreaterThan(105);
    expect(remaining / 1000).toBeLessThan(120);
  });

  it("reports how far off the route the truck is", () => {
    const projection = projectOnLine(line, { latitude: 52.72, longitude: 9.6 })!;
    expect(projection.offMeters).toBeGreaterThan(5_000);
  });

  it("cuts the line at the truck", () => {
    const projection = projectOnLine(line, { latitude: 52.72, longitude: 9.27 })!;
    const split = splitAtProjection(line, projection);
    expect(split.travelledGeometry.at(-1)).toEqual(projection.point);
    expect(split.remainingGeometry[0]).toEqual(projection.point);
    expect(split.remainingGeometry.at(-1)).toEqual(line[2]);
  });
});
