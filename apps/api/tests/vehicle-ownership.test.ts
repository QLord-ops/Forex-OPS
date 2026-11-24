import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/sqlite-client/index.js";
import { mayChangeVehicle, ownershipTarget, vehicleOfTarget } from "../src/services/vehicle-ownership.js";
import { asAppDatabase, migrateTestDatabase } from "./test-database.js";

let directory: string;
let sqlite: PrismaClient;
const ids: Record<string, string> = {};
const now = new Date("2026-11-24T10:00:00Z");
const db = () => asAppDatabase(sqlite);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ops-ownership-"));
  sqlite = new PrismaClient({ datasources: { db: { url: `file:${join(directory, "test.db")}` } } });
  await migrateTestDatabase(sqlite);
  for (const login of ["anna", "ben"]) ids[login] = (await sqlite.dispatcher.create({ data: { login, displayName: login, role: "dispatcher", passwordHash: "x" } })).id;
  const customer = await sqlite.customer.create({ data: { name: "Geis", slug: "GEIS" } });
  for (const code of ["NORD", "SUED"]) ids[code] = (await sqlite.customerLine.create({ data: { customerId: customer.id, code, name: code } })).id;
  await sqlite.dispatcherLine.createMany({ data: [{ dispatcherId: ids.anna!, lineId: ids.NORD!, isPrimary: true }, { dispatcherId: ids.ben!, lineId: ids.SUED!, isPrimary: true }] });
  const truck = async (number: string, line: string, taken: string | null = null) => {
    ids[number] = (await sqlite.vehicle.create({ data: { vehicleNumber: number, customerLineId: ids[line], assignedDispatcherId: taken ? ids[taken] : null } })).id;
  };
  await truck("101", "NORD");          // free on Anna's line
  await truck("102", "NORD", "ben");   // on Anna's line, taken by Ben
  await truck("201", "SUED");          // free on Ben's line
  await truck("202", "SUED", "anna");  // on Ben's line, taken by Anna
  const tour = await sqlite.tour.create({ data: { vehicleId: ids["201"]!, orderNumber: "T-1", status: "ACTIVE" } });
  ids.tour = tour.id;
  ids.stop = (await sqlite.stop.create({ data: { tourId: tour.id, sequence: 1, type: "LOAD", address: "Bremen", latitude: 53.07, longitude: 8.8 } })).id;
}, 20_000);
afterAll(async () => { await sqlite?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

describe("a dispatcher changes only their own trucks (owner, 24.11)", () => {
  const may = (login: string, truck: string) => mayChangeVehicle(db(), ids[login]!, ids[truck]!, now);

  it("own: taken by me, or free on my line; not: taken by a colleague or free on a colleague's line", async () => {
    expect(await may("anna", "101")).toBe(true);
    expect(await may("anna", "202")).toBe(true);
    expect(await may("anna", "102")).toBe(false);
    expect(await may("anna", "201")).toBe(false);
    expect(await may("ben", "102")).toBe(true);
  });

  it("a cover makes the absent dispatcher's trucks the stand-in's", async () => {
    await sqlite.dispatcherCover.create({ data: { absentDispatcherId: ids.ben!, coverDispatcherId: ids.anna!, startsAt: new Date(now.getTime() - 3_600_000), endsAt: new Date(now.getTime() + 3_600_000), createdByDispatcherId: ids.ben! } });
    try {
      expect(await may("anna", "201")).toBe(true);
      expect(await may("ben", "201")).toBe(false);
    } finally { await sqlite.dispatcherCover.deleteMany(); }
  });

  it("finds the truck of a changing request by vehicle, tour, stop or the new tour's body", async () => {
    expect(ownershipTarget("POST", "/stops/:id/loaded", { id: ids.stop }, {})).toEqual({ kind: "stop", id: ids.stop });
    expect(await vehicleOfTarget(db(), { kind: "stop", id: ids.stop! })).toBe(ids["201"]);
    expect(await vehicleOfTarget(db(), { kind: "tour", id: ids.tour! })).toBe(ids["201"]);
    expect(ownershipTarget("PATCH", "/tours/:id", { id: ids.tour }, {})).toEqual({ kind: "tour", id: ids.tour });
    expect(ownershipTarget("POST", "/tours", {}, { vehicleId: ids["102"] })).toEqual({ kind: "vehicle", id: ids["102"] });
    expect(ownershipTarget("PUT", "/vehicles/:id/clock", { id: ids["102"] }, {})).toEqual({ kind: "vehicle", id: ids["102"] });
  });

  it("leaves reading, taking a truck, previews and the truck's own settings open to every dispatcher", () => {
    expect(ownershipTarget("GET", "/vehicles/:id/operations", { id: "x" }, null)).toBeNull();
    expect(ownershipTarget("POST", "/vehicles/:id/assignment", { id: "x" }, {})).toBeNull();
    expect(ownershipTarget("PATCH", "/vehicles/:id", { id: "x" }, {})).toBeNull();
    expect(ownershipTarget("PUT", "/vehicles/:id/customer-line", { id: "x" }, {})).toBeNull();
    expect(ownershipTarget("POST", "/tours/:id/replan/preview", { id: "x" }, {})).toBeNull();
    expect(ownershipTarget("POST", "/tours/preview", {}, { vehicleId: "x" })).toBeNull();
  });
});
