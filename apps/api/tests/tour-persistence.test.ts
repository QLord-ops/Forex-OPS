import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/sqlite-client/index.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MockRoutingProvider } from "../src/services/routing.js";
import { TourService } from "../src/services/tours.js";
import { asAppDatabase, migrateTestDatabase } from "./test-database.js";
import { OperationsService } from "../src/services/operations.js";
import { createInitialClockState } from "../src/services/vehicle-clock.js";
import { parseClockState, readPersistedDrivePlan } from "../src/services/tours.js";

let directory: string;
let db: PrismaClient;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ops-tour-test-"));
  const url = `file:${join(directory, "test.db")}`;
  db = new PrismaClient({ datasources: { db: { url } } });
  await migrateTestDatabase(db);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("carries machine hours and dwell into the queued transfer, and resumes with one version increment", async () => {
  const start = new Date("2026-10-11T08:00:00Z");
  const at = (hours: number) => new Date(start.getTime() + hours * 3600_000);
  const initial = createInitialClockState({ effectiveAt: start, drivingSeconds: 3 * 3600, continuousDrivingSeconds: 3 * 3600, dutySeconds: 4 * 3600 });
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "CLOCK-CARRY", clockState: JSON.stringify(initial) } });
  const provider = new MockRoutingProvider();
  provider.calculateRoute = async (from, to) => ({ provider: "test", geometry: [from, to], distanceMeters: 100_000, durationSeconds: 7200 });
  const tours = new TourService(asAppDatabase(db), provider);
  const operations = new OperationsService(asAppDatabase(db), tours);
  const input = { vehicleId: vehicle.id, orderNumber: "CLOCK-1", stops: [
    { sequence: 1, type: "LOAD" as const, address: "Berlin", appointmentAt: null },
    { sequence: 2, type: "UNLOAD" as const, address: "Hamburg", appointmentAt: null }
  ] };
  const first = await tours.createTour(input);
  const queued = await tours.createTour({ ...input, orderNumber: "CLOCK-2" });
  await operations.confirmArrival(first.stops[0].id, start, start);
  await tours.recordLoaded(first.stops[0].id, start);
  expect((await tours.getCurrentPosition(vehicle.id, at(1.25))).progress).toBeCloseTo(0.5);
  await operations.confirmArrival(first.stops[1].id, at(2.75), at(2.75));
  await tours.recordUnloaded(first.stops[1].id, at(3.75));
  const checkpoint = parseClockState((await db.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).clockState, at(3.75));
  expect(checkpoint.currentCycle.drivingSeconds).toBe(5 * 3600);
  expect(checkpoint.currentCycle.dutySeconds).toBe(7.75 * 3600);
  const transfer = await db.leg.findFirstOrThrow({ where: { tourId: queued.id, status: "ACTIVE" } });
  expect(readPersistedDrivePlan(transfer.drivePlan)?.clockPlan.initialState.currentCycle.drivingSeconds).toBe(5 * 3600);
  const version = (await db.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).operationVersion;
  await operations.manualStop(vehicle.id, version, at(4.25));
  const stopped = await operations.get(vehicle.id, at(5.25));
  expect(stopped.clock.currentCycle.drivingSeconds).toBe(5.5 * 3600);
  expect(stopped.clock.currentCycle.dutySeconds).toBe(9.25 * 3600);
  const resumed = await operations.resume(vehicle.id, stopped.version, at(5.25));
  expect(resumed.version).toBe(stopped.version + 1);
  expect(resumed.manualStoppedAt).toBeNull();
  expect(resumed.position.progress).toBeCloseTo(0.25);
  expect((await tours.getCurrentPosition(vehicle.id, at(5.5))).progress).toBeCloseTo(0.375);
});

it("persists new and edited tours, preserves transfer legs, and activates the queue after confirmation", async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "TEST-ONLY" } });
  const service = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const input = {
    vehicleId: vehicle.id, orderNumber: "TEST-1",
    stops: [
      { sequence: 1, type: "LOAD" as const, address: "Berlin", appointmentAt: "2026-10-08T08:00:00Z" },
      { sequence: 2, type: "UNLOAD" as const, address: "Hamburg", appointmentAt: "2026-10-08T12:00:00Z" }
    ]
  };
  const first = await service.createTour(input);
  const second = await service.createTour({ ...input, orderNumber: "TEST-2" });
  expect(first.status).toBe("ACTIVE");
  expect(second.status).toBe("QUEUED");
  expect(second.legs).toHaveLength(2);
  const edited = await service.updateFutureTour(second.id, { ...input, orderNumber: "TEST-2-EDITED" });
  expect(edited.orderNumber).toBe("TEST-2-EDITED");
  expect(edited.legs).toHaveLength(2);
  const third = await service.createTour({ ...input, orderNumber: "TEST-3" });
  await expect(service.updateFutureTour(second.id, input)).rejects.toMatchObject({ statusCode: 409 });
  expect(await db.leg.count({ where: { tourId: third.id } })).toBe(2);
  await expect(service.recordLoaded(first.stops[0].id, new Date("2026-10-08T08:00:00Z"))).rejects.toThrow("подтвердить прибытие");
  await db.stop.update({ where: { id: first.stops[0].id }, data: { arrivedAt: new Date("2026-10-08T07:00:00Z") } });
  await service.recordLoaded(first.stops[0].id, new Date("2026-10-08T08:00:00Z"));
  await db.stop.update({ where: { id: first.stops[1].id }, data: { arrivedAt: new Date("2026-10-08T11:00:00Z") } });
  await service.recordUnloaded(first.stops[1].id, new Date("2026-10-08T12:00:00Z"));
  expect((await db.tour.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("ACTIVE");
  expect(await db.event.count({ where: { tourId: first.id } })).toBe(2);
});
