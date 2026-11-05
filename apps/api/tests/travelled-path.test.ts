import { describe, expect, it } from "vitest";
import type { Coordinate } from "../src/domain.js";
import { cleanTravelled } from "../src/services/travelled-path.js";

const line = (from: [number, number], to: [number, number], steps: number): Coordinate[] =>
  Array.from({ length: steps + 1 }, (_, index) => ({ longitude: from[0] + (to[0] - from[0]) * index / steps, latitude: from[1] + (to[1] - from[1]) * index / steps }));

describe("driven part of a leg on the map", () => {
  it("draws no straight line across the country where an old plan was stitched to the truck's real road, and drops the stretch it did not drive", () => {
    // Recklinghausen → Unna, then the plan from Kassel that ran on east along the A44, while the truck took the A7 south.
    const westPiece = line([7.2, 51.6], [7.7, 51.53], 40);
    const kasselPiece = line([9.48, 51.3], [9.9, 51.22], 40);
    const truckRoad: Coordinate = { longitude: 9.52, latitude: 51.12 };
    const result = cleanTravelled([...westPiece, ...kasselPiece], truckRoad);
    expect(result.breaks).toEqual([westPiece.length, result.points.length]);
    expect(result.starts).toEqual([westPiece.length]);
    expect(Math.max(...result.points.map((point) => point.longitude))).toBeLessThan(9.65);
    expect(result.points.slice(0, westPiece.length)).toEqual(westPiece);
  });

  it("keeps a clean stitch as it is", () => {
    const driven = line([9.0, 51.0], [9.3, 51.1], 30);
    const result = cleanTravelled(driven, { longitude: 9.3, latitude: 51.1 });
    expect(result).toEqual({ points: driven, breaks: [], starts: [] });
  });

  it("cuts a short overshoot at a remembered stitch, without a break when the pieces meet", () => {
    const first = line([9.0, 51.0], [9.1, 51.0], 20);
    const overshoot = line([9.1, 51.0], [9.13, 51.0], 6).slice(1);
    const second = line([9.1, 51.0005], [9.1, 50.9], 20);
    const result = cleanTravelled([...first, ...overshoot, ...second], second[second.length - 1], [first.length + overshoot.length]);
    expect(result.breaks).toEqual([]);
    expect(result.points.some((point) => point.longitude > 9.101)).toBe(false);
    expect(result.points.slice(-second.length)).toEqual(second);
  });
});
