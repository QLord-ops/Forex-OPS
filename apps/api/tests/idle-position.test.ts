import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/sqlite-client/index.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MockRoutingProvider } from "../src/services/routing.js";
import { TourService } from "../src/services/tours.js";
import { asAppDatabase, migrateTestDatabase } from "./test-database.js";

let directory: string;
let db: PrismaClient;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ops-idle-position-"));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, "test.db")}` } } });
  await migrateTestDatabase(db);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("returns no position when the vehicle has neither a manual position nor a completed stop", async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "IDLE-EMPTY" } });
  const position = await new TourService(asAppDatabase(db), new MockRoutingProvider()).getCurrentPosition(vehicle.id);
  expect(position).toMatchObject({ state: "NO_ACTIVE_ROUTE", position: null, coordinate: null });
});

it("falls back to the dispatcher's manual position when no route is active", async () => {
  const vehicle = await db.vehicle.create({ data: {
    vehicleNumber: "IDLE-MANUAL", manualPositionLatitude: 51.58, manualPositionLongitude: 9.95, manualPositionAt: new Date("2026-10-11T08:00:00Z")
  } });
  const position = await new TourService(asAppDatabase(db), new MockRoutingProvider()).getCurrentPosition(vehicle.id);
  expect(position).toMatchObject({
    state: "NO_ACTIVE_ROUTE",
    position: { latitude: 51.58, longitude: 9.95 },
    coordinate: [9.95, 51.58],
    positionSource: "MANUAL",
    disclaimer: "Позиция указана диспетчером – не GPS"
  });
});

it("falls back to the last completed stop, preferring it over an older manual position", async () => {
  const vehicle = await db.vehicle.create({ data: {
    vehicleNumber: "IDLE-STOP", manualPositionLatitude: 1, manualPositionLongitude: 1, manualPositionAt: new Date("2026-10-01T08:00:00Z")
  } });
  const tour = await db.tour.create({ data: {
    vehicleId: vehicle.id, orderNumber: "DONE-1", status: "COMPLETED", completedAt: new Date("2026-10-11T12:00:00Z")
  } });
  await db.stop.createMany({ data: [
    { tourId: tour.id, sequence: 1, type: "LOAD", address: "Berlin", latitude: 52.52, longitude: 13.405, completedAt: new Date("2026-10-11T08:00:00Z") },
    { tourId: tour.id, sequence: 2, type: "UNLOAD", address: "Hamburg", latitude: 53.55, longitude: 9.99, completedAt: new Date("2026-10-11T12:00:00Z") }
  ] });
  const position = await new TourService(asAppDatabase(db), new MockRoutingProvider()).getCurrentPosition(vehicle.id);
  expect(position).toMatchObject({
    state: "NO_ACTIVE_ROUTE",
    position: { latitude: 53.55, longitude: 9.99 },
    positionSource: "CALCULATED",
    disclaimer: "Последняя завершённая точка – не GPS"
  });
});
