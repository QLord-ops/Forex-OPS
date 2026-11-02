import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/sqlite-client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      { sequence: 1, type: "LOAD" as const, address: "Berlin", appointmentAt: "2026-10-08T08:00:00Z", loadingMeters: 13.6, referenceNumbers: ["L-4711"], instructions: "Tor 4" },
      { sequence: 2, type: "UNLOAD" as const, address: "Hamburg", appointmentAt: "2026-10-08T12:00:00Z" }
    ]
  };
  const first = await service.createTour(input);
  const second = await service.createTour({ ...input, orderNumber: "TEST-2" });
  expect(first.status).toBe("ACTIVE");
  expect(first.stops[0]).toMatchObject({ loadingMeters: 13.6, referenceNumbersJson: '["L-4711"]', instructions: "Tor 4" });
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

it("confirms an imported Auftrag once and returns the attached tour on retry", async () => {
  const firstVehicle = await db.vehicle.create({ data: { vehicleNumber: "IMPORT-ONE" } });
  const secondVehicle = await db.vehicle.create({ data: { vehicleNumber: "IMPORT-TWO" } });
  const service = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const input = {
    vehicleId: firstVehicle.id,
    orderNumber: "AUFTRAG-2056258",
    stops: [
      {
        sequence: 1,
        type: "LOAD" as const,
        address: "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde",
        sourceAddress: "Rudolf-Diesel-Straße 2, D 14974 Ludwigsfelde",
        resolvedAddress: "Rudolf-Diesel-Straße, 14974 Ludwigsfelde, Deutschland",
        geocodePrecision: "STREET" as const,
        geocodeProvider: "nominatim",
        latitude: 52.3,
        longitude: 13.2
      },
      { sequence: 2, type: "UNLOAD" as const, address: "Sickingenstraße 28-38, 10553 Berlin", latitude: 52.5, longitude: 13.3 }
    ]
  };
  const metadata = { importAttemptId: "attempt-import-one", importFingerprint: "fingerprint-import-one" };

  const first = await service.createImportedTour(input, metadata);
  const retry = await service.createImportedTour(input, { ...metadata, importAttemptId: "attempt-import-retry" });

  expect(first.created).toBe(true);
  expect(retry.created).toBe(false);
  expect(retry.tour.id).toBe(first.tour.id);
  expect(retry.tour.vehicleId).toBe(firstVehicle.id);
  expect(retry.tour.stops[0]).toMatchObject({
    sourceAddress: "Rudolf-Diesel-Straße 2, D 14974 Ludwigsfelde",
    geocodePrecision: "STREET",
    geocodeProvider: "nominatim"
  });
  expect(await db.tour.count({ where: { importFingerprint: metadata.importFingerprint } })).toBe(1);

  await expect(service.createImportedTour({ ...input, vehicleId: secondVehicle.id }, {
    importAttemptId: "attempt-import-other-vehicle",
    importFingerprint: metadata.importFingerprint
  })).rejects.toMatchObject({ statusCode: 409 });
});

it("editing a queued tour keeps LDM, references, windows, trailer and remarks, and rejects a stale version", async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "EDIT-KEEP" } });
  const provider = new MockRoutingProvider();
  provider.calculateRoute = async (from, to) => ({ provider: "test", geometry: [from, to], distanceMeters: 50_000, durationSeconds: 3600 });
  const tours = new TourService(asAppDatabase(db), provider);
  const active = await tours.createTour({ vehicleId: vehicle.id, orderNumber: "EDIT-0", stops: [
    { sequence: 1, type: "LOAD", address: "Berlin", appointmentAt: null },
    { sequence: 2, type: "UNLOAD", address: "Hamburg", appointmentAt: null }] });
  expect(active.status).toBe("ACTIVE");
  const queued = await tours.createTour({ vehicleId: vehicle.id, orderNumber: "EDIT-1", trailerPlate: "GÖ-FX 812", tourRemarks: "Rampe 4, vorher anrufen", stops: [
    { sequence: 1, type: "LOAD", address: "Berlin", appointmentWindowStartAt: "2026-11-05T06:00:00.000Z", appointmentWindowEndAt: "2026-11-05T08:00:00.000Z",
      loadingMeters: 13.6, referenceNumbers: ["REF-1", "REF-2"], instructions: "Palettentausch" },
    { sequence: 2, type: "UNLOAD", address: "Hamburg", appointmentAt: null, loadingMeters: 13.6 }] });
  const saved = await db.tour.findUniqueOrThrow({ where: { id: queued.id }, include: { stops: { orderBy: { sequence: "asc" } } } });

  // The edit form only knows type, company, address, city, appointment and service minutes.
  const edited = await tours.updateFutureTour(queued.id, { vehicleId: vehicle.id, orderNumber: "EDIT-1B", version: saved.planVersion, stops: saved.stops.map((stop) => ({
    id: stop.id, sequence: stop.sequence, type: stop.type as "LOAD" | "UNLOAD", address: stop.address, latitude: stop.latitude, longitude: stop.longitude,
    appointmentAt: null, serviceMinMinutes: 60, serviceMaxMinutes: 120 })) });
  const after = await db.tour.findUniqueOrThrow({ where: { id: edited.id }, include: { stops: { orderBy: { sequence: "asc" } } } });
  expect(after.orderNumber).toBe("EDIT-1B");
  expect(after.trailerPlate).toBe("GÖ-FX 812");
  expect(after.tourRemarks).toBe("Rampe 4, vorher anrufen");
  expect(after.stops[0]).toMatchObject({ loadingMeters: 13.6, instructions: "Palettentausch", referenceNumbersJson: JSON.stringify(["REF-1", "REF-2"]) });
  expect(after.stops[0].appointmentWindowStartAt?.toISOString()).toBe("2026-11-05T06:00:00.000Z");
  expect(after.stops[1].loadingMeters).toBe(13.6);
  expect(after.planVersion).toBe(saved.planVersion + 1);

  await expect(tours.updateFutureTour(queued.id, { vehicleId: vehicle.id, orderNumber: "EDIT-1C", version: saved.planVersion, stops: [
    { sequence: 1, type: "LOAD", address: "Berlin" }, { sequence: 2, type: "UNLOAD", address: "Hamburg" }] }))
    .rejects.toMatchObject({ statusCode: 409 });
});

it("BELADEN/ENTLADEN rejects a time in the future or before the arrival", async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "EVENT-TIME" } });
  const provider = new MockRoutingProvider();
  provider.calculateRoute = async (from, to) => ({ provider: "test", geometry: [from, to], distanceMeters: 50_000, durationSeconds: 3600 });
  const tours = new TourService(asAppDatabase(db), provider);
  const operations = new OperationsService(asAppDatabase(db), tours);
  const tour = await tours.createTour({ vehicleId: vehicle.id, orderNumber: "EVENT-1", stops: [
    { sequence: 1, type: "LOAD", address: "Berlin", appointmentAt: null }, { sequence: 2, type: "UNLOAD", address: "Hamburg", appointmentAt: null }] });
  const arrived = new Date(Date.now() - 2 * 3600_000);
  await operations.confirmArrival(tour.stops[0].id, arrived, new Date());
  await expect(tours.recordLoaded(tour.stops[0].id, new Date(Date.now() + 3600_000))).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("будущем") });
  await expect(tours.recordLoaded(tour.stops[0].id, new Date(arrived.getTime() - 60_000))).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("раньше прибытия") });
  const loaded = await tours.recordLoaded(tour.stops[0].id, new Date(arrived.getTime() + 30 * 60_000));
  expect(loaded.stops[0].completedAt).not.toBeNull();
});

describe("queue by load date", () => {
  const stops = (load: string | null, city = "Berlin") => [
    { sequence: 1, type: "LOAD" as const, address: city, appointmentWindowStartAt: load, appointmentWindowEndAt: load ? load.replace("T05:00", "T17:00") : null },
    { sequence: 2, type: "UNLOAD" as const, address: "Hamburg", appointmentAt: null }
  ];
  async function setup(name: string) {
    const vehicle = await db.vehicle.create({ data: { vehicleNumber: name } });
    const provider = new MockRoutingProvider();
    provider.calculateRoute = async (from, to) => ({ provider: "test", geometry: [from, to], distanceMeters: 50_000, durationSeconds: 3600 });
    return { vehicle, tours: new TourService(asAppDatabase(db), provider), operations: new OperationsService(asAppDatabase(db), new TourService(asAppDatabase(db), provider)) };
  }
  const read = (vehicleId: string) => db.tour.findMany({ where: { vehicleId, status: { in: ["ACTIVE", "QUEUED"] } }, orderBy: { queueIndex: "asc" }, include: { legs: true, stops: { orderBy: { sequence: "asc" } } } });

  it("a tour that loads earlier becomes active before an active tour that has not started", async () => {
    const { vehicle, tours } = await setup("QUEUE-FRONT");
    const later = await tours.createTour({ vehicleId: vehicle.id, orderNumber: "LATER", stops: stops("2026-11-10T05:00:00.000Z") });
    expect(later.status).toBe("ACTIVE");
    expect(later.plannedStartAt?.toISOString()).toBe("2026-11-10T05:00:00.000Z");
    const earlier = await tours.createTour({ vehicleId: vehicle.id, orderNumber: "EARLIER", stops: stops("2026-11-05T05:00:00.000Z", "Göttingen") });
    const queue = await read(vehicle.id);
    expect(queue.map((tour) => [tour.orderNumber, tour.status, tour.queueIndex])).toEqual([["EARLIER", "ACTIVE", 0], ["LATER", "QUEUED", 1]]);
    expect(queue[1].previousTourId).toBe(earlier.id);
    const transfer = queue[1].legs.find((leg) => leg.toStopId === queue[1].stops[0].id);
    expect(transfer?.fromStopId).toBe(queue[0].stops.at(-1)!.id);
  });

  it("goes between a started active tour and a later queued one, re-linking the transfer legs", async () => {
    const { vehicle, tours, operations } = await setup("QUEUE-MIDDLE");
    const active = await tours.createTour({ vehicleId: vehicle.id, orderNumber: "RUNNING", stops: stops("2026-11-01T05:00:00.000Z") });
    await operations.confirmArrival(active.stops[0].id, new Date(Date.now() - 3600_000), new Date());
    const late = await tours.createTour({ vehicleId: vehicle.id, orderNumber: "NOV-12", stops: stops("2026-11-12T05:00:00.000Z", "Kassel") });
    const middle = await tours.createTour({ vehicleId: vehicle.id, orderNumber: "NOV-08", stops: stops("2026-11-08T05:00:00.000Z", "Einbeck") });
    const queue = await read(vehicle.id);
    expect(queue.map((tour) => [tour.orderNumber, tour.status, tour.queueIndex])).toEqual([["RUNNING", "ACTIVE", 0], ["NOV-08", "QUEUED", 1], ["NOV-12", "QUEUED", 2]]);
    expect(queue[1].previousTourId).toBe(active.id);
    expect(queue[2].previousTourId).toBe(middle.id);
    const transfers = (index: number) => queue[index].legs.filter((leg) => leg.toStopId === queue[index].stops[0].id);
    expect(transfers(1).map((leg) => leg.fromStopId)).toEqual([queue[0].stops.at(-1)!.id]);
    expect(transfers(2).map((leg) => leg.fromStopId)).toEqual([queue[1].stops.at(-1)!.id]);
    expect(late.status).toBe("QUEUED");
  });

  it("a tour without a date keeps today's behaviour and goes to the end", async () => {
    const { vehicle, tours } = await setup("QUEUE-UNDATED");
    await tours.createTour({ vehicleId: vehicle.id, orderNumber: "DATED", stops: stops("2026-11-20T05:00:00.000Z") });
    await tours.createTour({ vehicleId: vehicle.id, orderNumber: "UNDATED", stops: stops(null) });
    expect((await read(vehicle.id)).map((tour) => tour.orderNumber)).toEqual(["DATED", "UNDATED"]);
  });
});
