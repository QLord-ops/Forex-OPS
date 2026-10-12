import type { Coordinate, RouteGeometry, RiskColor } from "../domain.js";

const EARTH_RADIUS_METERS = 6_371_000;

export function calculateHaversineDistanceMeters(a: Coordinate, b: Coordinate): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const deltaLat = toRad(b.latitude - a.latitude);
  const deltaLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export function calculatePolylineDistanceMeters(geometry: RouteGeometry): number {
  if (geometry.length < 2) return 0;

  return geometry.slice(1).reduce((sum, point, index) => {
    return sum + calculateHaversineDistanceMeters(geometry[index], point);
  }, 0);
}

export function calculateSimulatedDuration(
  distanceMeters: number,
  routingDurationSeconds: number,
  maxSpeedKmh: number
): number {
  if (distanceMeters <= 0) return 0;
  const effectiveSpeed = Math.min(Math.max(maxSpeedKmh, 1), 85);
  const minDurationSeconds = distanceMeters / ((effectiveSpeed * 1000) / 3600);
  return Math.ceil(Math.max(routingDurationSeconds, minDurationSeconds));
}

export function calculateProgress(
  startedAt: Date | null | undefined,
  now: Date,
  simulatedDurationSeconds: number,
  finishedAt?: Date | null
): number {
  if (finishedAt) return 1;
  if (!startedAt) return 0;
  if (simulatedDurationSeconds <= 0) return 1;

  const elapsedSeconds = (now.getTime() - startedAt.getTime()) / 1000;
  return Math.max(0, Math.min(1, elapsedSeconds / simulatedDurationSeconds));
}

export function calculateDistanceTravelled(distanceMeters: number, progress: number): number {
  return Math.round(Math.max(0, distanceMeters) * Math.max(0, Math.min(1, progress)));
}

export function calculateRemainingDistance(distanceMeters: number, progress: number): number {
  return Math.max(0, Math.round(distanceMeters - calculateDistanceTravelled(distanceMeters, progress)));
}

export function calculatePositionOnRoute(geometry: RouteGeometry, progress: number): Coordinate | null {
  if (geometry.length === 0) return null;
  if (geometry.length === 1) return geometry[0];

  const totalDistance = calculatePolylineDistanceMeters(geometry);
  if (totalDistance <= 0) return geometry[0];

  const clampedProgress = Math.max(0, Math.min(1, progress));
  const targetDistance = totalDistance * clampedProgress;
  let travelled = 0;

  for (let index = 1; index < geometry.length; index += 1) {
    const start = geometry[index - 1];
    const end = geometry[index];
    const segmentDistance = calculateHaversineDistanceMeters(start, end);

    if (travelled + segmentDistance >= targetDistance) {
      const segmentProgress = segmentDistance === 0 ? 0 : (targetDistance - travelled) / segmentDistance;
      return {
        latitude: start.latitude + (end.latitude - start.latitude) * segmentProgress,
        longitude: start.longitude + (end.longitude - start.longitude) * segmentProgress
      };
    }

    travelled += segmentDistance;
  }

  return geometry[geometry.length - 1];
}

export function splitGeometryAtProgress(
  geometry: RouteGeometry,
  progress: number
): { travelledGeometry: RouteGeometry; remainingGeometry: RouteGeometry } {
  const position = calculatePositionOnRoute(geometry, progress);
  if (!position) return { travelledGeometry: [], remainingGeometry: [] };
  if (geometry.length <= 1) return { travelledGeometry: geometry, remainingGeometry: geometry };

  const clampedProgress = Math.max(0, Math.min(1, progress));
  if (clampedProgress <= 0) return { travelledGeometry: [geometry[0]], remainingGeometry: geometry };
  if (clampedProgress >= 1) return { travelledGeometry: geometry, remainingGeometry: [geometry[geometry.length - 1]] };

  const totalDistance = calculatePolylineDistanceMeters(geometry);
  const targetDistance = totalDistance * clampedProgress;
  let travelled = 0;

  for (let index = 1; index < geometry.length; index += 1) {
    const start = geometry[index - 1];
    const end = geometry[index];
    const segmentDistance = calculateHaversineDistanceMeters(start, end);
    if (travelled + segmentDistance >= targetDistance) {
      return {
        travelledGeometry: [...geometry.slice(0, index), position],
        remainingGeometry: [position, ...geometry.slice(index)]
      };
    }
    travelled += segmentDistance;
  }

  return { travelledGeometry: geometry, remainingGeometry: [geometry[geometry.length - 1]] };
}

export function calculateEta(startedAt: Date | null | undefined, simulatedDurationSeconds: number): Date | null {
  if (!startedAt) return null;
  return new Date(startedAt.getTime() + simulatedDurationSeconds * 1000);
}

export function calculateLateMinutes(eta: Date | null, appointmentAt: Date | null): number {
  if (!appointmentAt) return 0;
  if (!eta) return 0;
  return Math.max(0, Math.ceil((eta.getTime() - appointmentAt.getTime()) / 60_000));
}

export function calculateRiskColor(eta: Date | null, appointmentAt?: Date | null): RiskColor {
  if (!eta || !appointmentAt) return "GREY";

  const diffMinutes = Math.ceil((eta.getTime() - appointmentAt.getTime()) / 60_000);
  if (diffMinutes > 30) return "RED";
  if (diffMinutes > 0) return "ORANGE";
  if (diffMinutes >= -15) return "YELLOW";
  return "GREEN";
}

export function parseGeometry(routeGeometry: string): RouteGeometry {
  const parsed = JSON.parse(routeGeometry) as unknown;
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((point) => {
      if (
        typeof point === "object" &&
        point !== null &&
        "latitude" in point &&
        "longitude" in point &&
        typeof point.latitude === "number" &&
        typeof point.longitude === "number"
      ) {
        return { latitude: point.latitude, longitude: point.longitude };
      }
      return null;
    })
    .filter((point): point is Coordinate => point !== null);
}

export function serializeGeometry(geometry: RouteGeometry): string {
  return JSON.stringify(geometry);
}
