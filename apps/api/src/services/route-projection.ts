import type { Coordinate, RouteGeometry } from "../domain.js";
import { calculateHaversineDistanceMeters } from "./simulation.js";

/** Beyond this distance from the planned line the truck is off its route. */
export const OFF_ROUTE_METERS = 2_000;

export type RouteProjection = {
  /** Index of the segment start the point falls on. */
  index: number;
  /** Closest point on the line. */
  point: Coordinate;
  alongMeters: number;
  totalMeters: number;
  /** Distance from the GPS point to the line. */
  offMeters: number;
};

/**
 * Where a GPS point lies on a route line: the nearest point on any segment, how far along the line it is and how far off it.
 * Uses a local flat projection per segment, which is accurate to metres at the distances between route points.
 */
export function projectOnLine(line: RouteGeometry, gps: Coordinate): RouteProjection | null {
  if (line.length < 2) return null;
  let best: RouteProjection | null = null;
  let walked = 0;
  for (let index = 0; index < line.length - 1; index += 1) {
    const a = line[index];
    const b = line[index + 1];
    const segment = calculateHaversineDistanceMeters(a, b);
    const cos = Math.cos(((a.latitude + b.latitude) / 2) * Math.PI / 180);
    const bx = (b.longitude - a.longitude) * cos;
    const by = b.latitude - a.latitude;
    const px = (gps.longitude - a.longitude) * cos;
    const py = gps.latitude - a.latitude;
    const lengthSquared = bx * bx + by * by;
    const t = lengthSquared > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / lengthSquared)) : 0;
    const point = { latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t };
    const offMeters = calculateHaversineDistanceMeters(point, gps);
    if (!best || offMeters < best.offMeters) best = { index, point, alongMeters: walked + segment * t, totalMeters: 0, offMeters };
    walked += segment;
  }
  return best ? { ...best, totalMeters: walked } : null;
}

/** The line cut at a projected point: what is behind the truck and what is ahead. */
export function splitAtProjection(line: RouteGeometry, projection: RouteProjection) {
  return {
    travelledGeometry: [...line.slice(0, projection.index + 1), projection.point],
    remainingGeometry: [projection.point, ...line.slice(projection.index + 1)]
  };
}
