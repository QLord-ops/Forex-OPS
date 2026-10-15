import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/sqlite-client/index.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CurrentPosition } from "../src/domain.js";
import { AppointmentService } from "../src/services/appointments.js";
import { EtaService } from "../src/services/eta.js";
import { makePersistedDrivePlan } from "../src/services/tours.js";
import { createInitialClockState } from "../src/services/vehicle-clock.js";
import { asAppDatabase, migrateTestDatabase } from "./test-database.js";

let db: PrismaClient;
let directory: string;
const now = new Date("2026-10-12T08:00:00Z");

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ops-appointment-test-"));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, "test.db")}` } } });
  await migrateTestDatabase(db);
}, 20_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("previews and atomically attaches a late-arriving appointment to an active Auftrag", async () => {
  const clock = createInitialClockState({ effectiveAt: now });
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "TERM-ACTIVE", clockState: JSON.stringify(clock) } });
  const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: "TERM-1", status: "ACTIVE" } });
  const load = await db.stop.create({ data: {
    tourId: tour.id, sequence: 1, type: "LOAD", address: "Berlin", city: "Berlin",
    latitude: 52.52, longitude: 13.405, arrivedAt: now, completedAt: now
  } });
  const unload = await db.stop.create({ data: {
    tourId: tour.id, sequence: 2, type: "UNLOAD", address: "Hamburg", city: "Hamburg",
    latitude: 53.55, longitude: 9.99
  } });
  const leg = await db.leg.create({ data: {
    tourId: tour.id, fromStopId: load.id, toStopId: unload.id, status: "ACTIVE", startedAt: now,
    routeGeometry: JSON.stringify([load, unload]), distanceMeters: 100_000,
    routingDurationSeconds: 7_200, simulatedDurationSeconds: 7_200,
    drivePlan: JSON.stringify(makePersistedDrivePlan(clock, 7_200, now))
  } });
  const position = { legId: leg.id, status: "MOVING" } as CurrentPosition;
  const service = new AppointmentService(asAppDatabase(db), new EtaService(), async () => position);
  const appointmentAt = new Date(now.getTime() + 3 * 3_600_000).toISOString();

  const preview = await service.preview(unload.id, { appointmentAt }, now);
  expect(preview).toMatchObject({
    stopId: unload.id,
    version: 0,
    risk: "ON_TIME",
    action: "IN_TRANSIT",
    bufferMinutes: 60,
    recommendedStartAt: null
  });
  expect(preview.earliestArrival).toBe(new Date(now.getTime() + 2 * 3_600_000).toISOString());

  const applied = await service.apply(unload.id, { appointmentAt, version: preview.version }, now);
  expect(applied.version).toBe(1);
  expect((await db.stop.findUniqueOrThrow({ where: { id: unload.id } })).appointmentAt?.toISOString()).toBe(appointmentAt);
  expect((await db.tour.findUniqueOrThrow({ where: { id: tour.id } })).planVersion).toBe(1);
  const event = await db.operationEvent.findFirstOrThrow({ where: { stopId: unload.id, type: "APPOINTMENT_ATTACHED" } });
  expect(event.reason).toContain("Машина уже в пути");
  expect(JSON.parse(event.payloadJson ?? "{}")).toMatchObject({ risk: "ON_TIME", action: "IN_TRANSIT", recommendedStartAt: null });
  await expect(service.apply(unload.id, { appointmentAt, version: 0 }, now)).rejects.toMatchObject({ statusCode: 409 });
});

it("marks the first point forecast as preliminary when the machine position is unknown", async () => {
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "TERM-NO-POSITION" } });
  const tour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: "TERM-2", status: "ACTIVE" } });
  const load = await db.stop.create({ data: {
    tourId: tour.id, sequence: 1, type: "LOAD", address: "Bremen", city: "Bremen",
    latitude: 53.08, longitude: 8.8
  } });
  const service = new AppointmentService(asAppDatabase(db), new EtaService());
  const preview = await service.preview(load.id, { appointmentAt: new Date(now.getTime() + 4 * 3_600_000).toISOString() }, now);

  expect(preview).toMatchObject({
    risk: "UNKNOWN",
    action: "UNKNOWN_POSITION",
    recommendedStartAt: null,
    earliestArrival: null,
    latestArrival: null,
    bufferMinutes: null,
    preliminary: true
  });

  const attached = await service.apply(load.id, {
    appointmentAt: new Date(now.getTime() + 4 * 3_600_000).toISOString(),
    version: preview.version
  }, now);
  expect(attached.earliestArrival).toBeNull();
  expect((await db.tour.findUniqueOrThrow({ where: { id: tour.id } })).plannedStartAt).toBeNull();
});

it("uses a routed manual approach for the first stop without treating its appointment as the tour start", async () => {
  const clock = createInitialClockState({ effectiveAt: now });
  const vehicle = await db.vehicle.create({ data: {
    vehicleNumber: "TERM-MANUAL-ORIGIN", clockState: JSON.stringify(clock),
    manualPositionAddress: "Berlin", manualPositionLatitude: 52.52,
    manualPositionLongitude: 13.405, manualPositionAt: now
  } });
  const tour = await db.tour.create({ data: {
    vehicleId: vehicle.id, orderNumber: "TERM-ORIGIN", status: "ACTIVE",
    approachDurationSeconds: 7_200, approachDistanceMeters: 100_000,
    plannedStartAt: new Date(now.getTime() + 30 * 60_000)
  } });
  const load = await db.stop.create({ data: {
    tourId: tour.id, sequence: 1, type: "LOAD", address: "Hamburg", city: "Hamburg",
    latitude: 53.55, longitude: 9.99
  } });
  const service = new AppointmentService(asAppDatabase(db), new EtaService());
  const appointmentAt = new Date(now.getTime() + 4 * 3_600_000).toISOString();

  const preview = await service.preview(load.id, { appointmentAt }, now);
  expect(preview).toMatchObject({
    risk: "ON_TIME", action: "LEAVE_BY", bufferMinutes: 120,
    earliestArrival: new Date(now.getTime() + 2 * 3_600_000).toISOString(),
    latestArrival: new Date(now.getTime() + 2 * 3_600_000).toISOString(),
    recommendedStartAt: new Date(now.getTime() + 2 * 3_600_000).toISOString()
  });

  await service.apply(load.id, { appointmentAt, version: preview.version }, now);
  expect((await db.tour.findUniqueOrThrow({ where: { id: tour.id } })).plannedStartAt?.toISOString())
    .toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
});

it("calculates when a queued machine must leave for a newly received appointment", async () => {
  const clock = createInitialClockState({ effectiveAt: now });
  const vehicle = await db.vehicle.create({ data: { vehicleNumber: "TERM-QUEUED", clockState: JSON.stringify(clock) } });
  const activeTour = await db.tour.create({ data: { vehicleId: vehicle.id, orderNumber: "TERM-3-A", status: "ACTIVE", queueIndex: 0 } });
  const previousStop = await db.stop.create({ data: {
    tourId: activeTour.id, sequence: 1, type: "UNLOAD", address: "Berlin", city: "Berlin",
    latitude: 52.52, longitude: 13.405, arrivedAt: now, completedAt: now
  } });
  const queuedTour = await db.tour.create({ data: {
    vehicleId: vehicle.id, orderNumber: "TERM-3-B", status: "QUEUED", queueIndex: 1, previousTourId: activeTour.id
  } });
  const load = await db.stop.create({ data: {
    tourId: queuedTour.id, sequence: 1, type: "LOAD", address: "Hamburg", city: "Hamburg",
    latitude: 53.55, longitude: 9.99
  } });
  await db.leg.create({ data: {
    tourId: queuedTour.id, fromStopId: previousStop.id, toStopId: load.id, status: "PLANNED",
    routeGeometry: JSON.stringify([previousStop, load]), distanceMeters: 100_000,
    routingDurationSeconds: 7_200, simulatedDurationSeconds: 7_200
  } });
  const service = new AppointmentService(asAppDatabase(db), new EtaService());
  const appointmentAt = new Date(now.getTime() + 5 * 3_600_000).toISOString();

  const preview = await service.preview(load.id, { appointmentAt }, now);

  expect(preview).toMatchObject({
    risk: "ON_TIME",
    action: "LEAVE_BY",
    bufferMinutes: 180,
    recommendedStartAt: new Date(now.getTime() + 3 * 3_600_000).toISOString()
  });

  await service.apply(load.id, { appointmentAt, version: preview.version }, now);
  const event = await db.operationEvent.findFirstOrThrow({ where: { stopId: load.id, type: "APPOINTMENT_ATTACHED" } });
  expect(event.reason).toContain(preview.recommendedStartAt!);
  expect(JSON.parse(event.payloadJson ?? "{}")).toMatchObject({
    recommendedStartAt: preview.recommendedStartAt,
    risk: "ON_TIME",
    action: "LEAVE_BY"
  });
});
