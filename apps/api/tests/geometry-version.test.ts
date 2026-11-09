import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/sqlite-client/index.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MockRoutingProvider } from "../src/services/routing.js";
import { makePersistedDrivePlan, TourService } from "../src/services/tours.js";
import { createUnknownClockState } from "../src/services/vehicle-clock.js";
import { asAppDatabase, migrateTestDatabase } from "./test-database.js";

let directory: string;
let db: PrismaClient;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ops-geometry-version-"));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, "test.db")}` } } });
  await migrateTestDatabase(db);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("keeps the geometry version while only the leg row is touched, and changes it with the line", async () => {
  const service = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "GEO-1" } });
  await service.createTour({ vehicleId: vehicle.id, orderNumber: "GEO", stops: [
    { sequence: 1, type: "LOAD", address: "Berlin", latitude: 52.52, longitude: 13.405 },
    { sequence: 2, type: "UNLOAD", address: "Hamburg", latitude: 53.55, longitude: 9.99 }
  ] });
  const leg = await db.leg.findFirstOrThrow({ where: { tour: { vehicleId: vehicle.id } } });
  await db.leg.update({ where: { id: leg.id }, data: { status: "ACTIVE", startedAt: new Date(Date.now() - 10 * 60_000) } });
  const first = await service.getCurrentPosition(vehicle.id);
  expect(first.geometryVersion).toBeTruthy();

  // A background check rewrites the row (new updatedAt) without changing the line.
  await new Promise((resolve) => setTimeout(resolve, 15));
  await db.leg.update({ where: { id: leg.id }, data: { drivePlan: leg.drivePlan } });
  expect((await service.getCurrentPosition(vehicle.id)).geometryVersion).toBe(first.geometryVersion);

  await db.leg.update({ where: { id: leg.id }, data: { routeGeometry: JSON.stringify([{ latitude: 52.52, longitude: 13.405 }, { latitude: 53, longitude: 11 }, { latitude: 53.55, longitude: 9.99 }]) } });
  expect((await service.getCurrentPosition(vehicle.id)).geometryVersion).not.toBe(first.geometryVersion);
});

it("returns congested stretches shifted by the already travelled part", async () => {
  const service = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "GEO-TRAFFIC" } });
  await service.createTour({ vehicleId: vehicle.id, orderNumber: "GEO-T", stops: [
    { sequence: 1, type: "LOAD", address: "Berlin", latitude: 52.52, longitude: 13.405 },
    { sequence: 2, type: "UNLOAD", address: "Hamburg", latitude: 53.55, longitude: 9.99 }
  ] });
  const leg = await db.leg.findFirstOrThrow({ where: { tour: { vehicleId: vehicle.id } } });
  const line = [{ latitude: 52.52, longitude: 13.405 }, { latitude: 52.8, longitude: 12.5 }, { latitude: 53.1, longitude: 11.5 }, { latitude: 53.55, longitude: 9.99 }];
  await db.leg.update({ where: { id: leg.id }, data: { status: "ACTIVE", startedAt: new Date(Date.now() - 5 * 60_000), routeGeometry: JSON.stringify(line),
    routeDetails: JSON.stringify({ travelledGeometry: [[13.9, 52.4], [13.6, 52.5]], activeRoute: { checkedAt: "2026-11-02T10:00:00.000Z",
      trafficSections: [{ start: 1, end: 2, level: "JAM", delaySeconds: 240, speedKmh: 22 }, { start: 2, end: 9, level: "SLOW", delaySeconds: 10, speedKmh: 60 }],
      roadSections: [{ start: 0, end: 2, road: "A24" }, { start: 2, end: 3, road: "A1" }, { start: 3, end: 9, road: "A7" }] } }) } });
  const position = await service.getCurrentPosition(vehicle.id);
  expect(position.routeGeometry).toHaveLength(6);
  expect(position.trafficSegments).toEqual([{ from: 3, to: 4, level: "JAM", delaySeconds: 240, speedKmh: 22 }]);
  expect(position.roadSegments).toEqual([{ from: 2, to: 4, road: "A24" }, { from: 4, to: 5, road: "A1" }]);
  expect(position.trafficCheckedAt).toBe("2026-11-02T10:00:00.000Z");
});

it("measures distance and ETA from fresh GPS and never marks the truck arrived by the timer", async () => {
  const service = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "GPS-9724" } });
  await service.createTour({ vehicleId: vehicle.id, orderNumber: "GPS", stops: [
    { sequence: 1, type: "LOAD", address: "Hannover", latitude: 52.37, longitude: 9.73 },
    { sequence: 2, type: "UNLOAD", address: "Emden", latitude: 53.36, longitude: 7.2 }
  ] });
  const leg = await db.leg.findFirstOrThrow({ where: { tour: { vehicleId: vehicle.id } } });
  const line = [{ latitude: 52.37, longitude: 9.73 }, { latitude: 53.07, longitude: 8.8 }, { latitude: 53.36, longitude: 7.2 }];
  // The timer says the leg is over long ago; the truck is really in Bremen.
  await db.leg.update({ where: { id: leg.id }, data: { status: "ACTIVE", startedAt: new Date(Date.now() - 24 * 3600_000), routeGeometry: JSON.stringify(line), distanceMeters: 230_000 } });

  const timer = await service.getCurrentPosition(vehicle.id);
  expect(timer.status).toBe("ARRIVED");
  expect(timer.predictedArrival).toBe(true);

  const gps = await service.getCurrentPosition(vehicle.id, new Date(), { latitude: 53.07, longitude: 8.8, fresh: true });
  expect(gps.status).toBe("MOVING");
  expect(gps.etaSource).toBe("GPS");
  expect(gps.remainingDistanceMeters / 1000).toBeGreaterThan(100);
  expect(gps.remainingDistanceMeters / 1000).toBeLessThan(125);
  expect(Date.parse(gps.eta!)).toBeGreaterThan(Date.now());
  expect(gps.offRouteMeters).toBeLessThan(100);

  // Stale GPS does not move anything.
  const stale = await service.getCurrentPosition(vehicle.id, new Date(), { latitude: 53.07, longitude: 8.8, fresh: false });
  expect(stale.etaSource).toBe("CALCULATED");
});

it("without the truck's starting hours a GPS ETA is the remaining drive, not a daily rest the timer invented (LKW B-CY2803)", async () => {
  const service = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "B-CY2803" } });
  await service.createTour({ vehicleId: vehicle.id, orderNumber: "20565840", stops: [
    { sequence: 1, type: "LOAD", address: "Hannover", latitude: 52.37, longitude: 9.73 },
    { sequence: 2, type: "UNLOAD", address: "Emden", latitude: 53.36, longitude: 7.2 }
  ] });
  const leg = await db.leg.findFirstOrThrow({ where: { tour: { vehicleId: vehicle.id } } });
  const line = [{ latitude: 52.37, longitude: 9.73 }, { latitude: 53.07, longitude: 8.8 }, { latitude: 53.36, longitude: 7.2 }];
  const now = new Date();
  // The leg began 2 h ago with a clock that guessed the hours were nearly used up: its plan is 30 min of driving, then an
  // 11 h daily rest. By the timer the driver is resting now; GPS shows the truck on the road.
  const startedAt = new Date(now.getTime() - 2 * 3600_000);
  const guessed = createUnknownClockState(new Date(startedAt.getTime() - 12 * 3600_000));
  guessed.currentCycle.drivingSeconds = 8.5 * 3600;
  guessed.currentCycle.dutySeconds = 12 * 3600;
  guessed.updatedAt = startedAt.toISOString();
  await db.leg.update({ where: { id: leg.id }, data: { status: "ACTIVE", startedAt, routeGeometry: JSON.stringify(line), distanceMeters: 230_000, simulatedDurationSeconds: 3 * 3600,
    drivePlan: JSON.stringify(makePersistedDrivePlan(guessed, 3 * 3600, startedAt)) } });
  await db.vehicle.update({ where: { id: vehicle.id }, data: { clockState: JSON.stringify(guessed) } });

  const gps = await service.getCurrentPosition(vehicle.id, now, { latitude: 53.07, longitude: 8.8, fresh: true });
  expect(gps.etaSource).toBe("GPS");
  // About half of a 3 h leg is left: arrival within about 2 h, not after a 9–11 h rest.
  const hours = (Date.parse(gps.eta!) - now.getTime()) / 3600_000;
  expect(hours).toBeGreaterThan(1);
  expect(hours).toBeLessThan(2.5);
});

it("sends the driven part without a straight line between stitched pieces and without the stretch the truck did not drive", async () => {
  const service = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "GEO-STITCH" } });
  await service.createTour({ vehicleId: vehicle.id, orderNumber: "GEO-S", stops: [
    { sequence: 1, type: "LOAD", address: "Recklinghausen", latitude: 51.6, longitude: 7.2 },
    { sequence: 2, type: "UNLOAD", address: "Erfurt", latitude: 50.98, longitude: 11.03 }
  ] });
  const leg = await db.leg.findFirstOrThrow({ where: { tour: { vehicleId: vehicle.id } } });
  const steps = (from: [number, number], to: [number, number], count: number) =>
    Array.from({ length: count + 1 }, (_, index) => [from[0] + (to[0] - from[0]) * index / count, from[1] + (to[1] - from[1]) * index / count]);
  const west = steps([7.2, 51.6], [7.7, 51.53], 40);
  const spur = steps([9.48, 51.3], [9.9, 51.22], 40);
  const line = [{ latitude: 51.12, longitude: 9.52 }, { latitude: 51.0, longitude: 10.3 }, { latitude: 50.98, longitude: 11.03 }];
  await db.leg.update({ where: { id: leg.id }, data: { status: "ACTIVE", startedAt: new Date(Date.now() - 5 * 60_000), routeGeometry: JSON.stringify(line),
    routeDetails: JSON.stringify({ travelledGeometry: [...west, ...spur], activeRoute: { roadSections: [{ start: 0, end: 2, road: "A4" }] } }) } });
  const position = await service.getCurrentPosition(vehicle.id);
  const prefixLength = position.routeGeometry.length - line.length;
  expect(position.routeBreaks).toEqual([west.length, prefixLength]);
  expect(position.routeGeometry.slice(0, prefixLength).every(([longitude]) => longitude < 9.65)).toBe(true);
  expect(position.roadSegments).toEqual([{ from: prefixLength, to: prefixLength + 2, road: "A4" }]);
});
