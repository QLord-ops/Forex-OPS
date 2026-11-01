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
