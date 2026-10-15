import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/sqlite-client/index.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MockRoutingProvider } from "../src/services/routing.js";
import { TourService } from "../src/services/tours.js";
import { asAppDatabase, migrateTestDatabase } from "./test-database.js";

let directory: string;
let db: PrismaClient;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ops-auftrag-intake-"));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, "test.db")}` } } });
  await migrateTestDatabase(db);
});

afterEach(async () => {
  await db.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

it("atomically creates an Auftrag with a new truck and preserves trailer, remarks, street and time window", async () => {
  const service = new TourService(asAppDatabase(db), new MockRoutingProvider());
  const result = await service.createTourForNewVehicle({
    vehicle: { vehicleNumber: "125", licensePlate: "B-CY7490" },
    tour: {
      orderNumber: "20562789",
      trailerPlate: "Z-S3153",
      tourRemarks: "85354 Freising für 30890 Barsinghausen // kein Tausch",
      stops: [
        { sequence: 1, type: "LOAD", address: "Lindenstraße 4, 85354 Freising", city: "Freising", latitude: 48.402, longitude: 11.748, appointmentWindowStartAt: "2026-10-15T09:00:00.000Z", appointmentWindowEndAt: "2026-10-15T11:00:00.000Z", loadingMeters: 10.4, referenceNumbers: ["008965"], serviceMinMinutes: 60, serviceMaxMinutes: 120 },
        { sequence: 2, type: "UNLOAD", address: "Dieselstraße 2, 30890 Barsinghausen", city: "Barsinghausen", latitude: 52.305, longitude: 9.462, appointmentAt: "2026-10-16T11:30:00.000Z", referenceNumbers: ["23283958"], serviceMinMinutes: 60, serviceMaxMinutes: 120 }
      ]
    }
  });

  expect(result.tour.status).toBe("ACTIVE");
  expect(result.vehicle.currentTrailerPlate).toBe("Z-S3153");
  expect(result.tour.trailerPlate).toBe("Z-S3153");
  expect(result.tour.tourRemarks).toContain("Freising");
  expect(result.tour.plannedStartAt).toBeNull();
  expect(result.tour.stops[0]).toMatchObject({ address: "Lindenstraße 4, 85354 Freising", loadingMeters: 10.4 });
  expect(result.tour.stops[0].appointmentWindowStartAt?.toISOString()).toBe("2026-10-15T09:00:00.000Z");
  expect(result.tour.stops[0].appointmentWindowEndAt?.toISOString()).toBe("2026-10-15T11:00:00.000Z");
  expect(await db.operationEvent.count({ where: { vehicleId: result.vehicle.id, type: "TRAILER_CHANGED" } })).toBe(1);
});
