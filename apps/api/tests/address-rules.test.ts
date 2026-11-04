import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient as PostgresPrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../src/generated/sqlite-client/index.js";
import { resolveAddressWithFallback } from "../src/services/address-resolution.js";
import { AddressRuleService, applyRulesToStop, BUILT_IN_RULES, expandCity, expandCompany, requiresTermin } from "../src/services/address-rules.js";
import { migrateTestDatabase } from "./test-database.js";

let directory: string;
let db: PrismaClient;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ops-address-rules-"));
  db = new PrismaClient({ datasources: { db: { url: `file:${join(directory, "test.db")}` } } });
  await migrateTestDatabase(db);
}, 20_000);
afterAll(async () => {
  await db?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("address rules", () => {
  it("spells out city codes and company abbreviations", () => {
    expect(expandCity("WOB")).toBe("Wolfsburg");
    expect(expandCity("Bremen")).toBe("Bremen");
    expect(expandCompany("VW")).toBe("Volkswagen AG");
    expect(expandCompany("VW Wolfsburg")).toBe("Volkswagen AG");
    expect(expandCompany("TST Süderelbe GmbH")).toBe("TST Süderelbe GmbH");
  });

  it("knows which customers always send a Termin", () => {
    for (const name of ["VW Braunschweig", "BLG Industrielogistik GmbH", "Mercedes-Benz AG / Werk 067", "Seifert", "Audi", "Rudolph Großmehring", "Rhenus"]) expect(requiresTermin(name)).toBe(true);
    expect(requiresTermin("TST Süderelbe GmbH")).toBe(false);
    const stop = applyRulesToStop({ company: "VW", address: "WOB", city: "WOB", appointmentLocal: null }, BUILT_IN_RULES);
    expect(stop).toMatchObject({ company: "Volkswagen AG", city: "Wolfsburg", terminRequired: true, sourceLabel: "VW Wolfsburg" });
    expect(applyRulesToStop({ company: "VW", address: "Wolfsburg", city: "Wolfsburg", appointmentLocal: "2026-11-05T08:00" }, BUILT_IN_RULES).terminRequired).toBe(false);
  });

  it("remembers a place the dispatcher typed and uses it for the next Auftrag", async () => {
    const service = new AddressRuleService(db as unknown as PostgresPrismaClient);
    const actor = { role: "dispatcher" as const, sessionId: "s1" };
    await service.learn({ sourceLabel: "Seifert Bremen", company: "Seifert Logistics", street: "Musterweg 5", postalCode: "28197", city: "Bremen", latitude: 53.1, longitude: 8.75 }, actor);
    const rules = await service.all();
    const next = applyRulesToStop({ company: "Seifert", address: "Bremen", city: "Bremen", appointmentLocal: null }, rules);
    expect(next).toMatchObject({ company: "Seifert Logistics", address: "Musterweg 5, 28197 Bremen", city: "Bremen", ruleApplied: true, terminRequired: true });
    expect(await db.auditLog.count({ where: { action: "ADDRESS_RULE_LEARNED" } })).toBe(1);

    const routing = { geocode: vi.fn(), route: vi.fn() };
    const resolved = await resolveAddressWithFallback(routing as never, { address: "Bremen", city: "Bremen", company: "Seifert" }, undefined, rules);
    expect(resolved).toMatchObject({ latitude: 53.1, longitude: 8.75, provider: "address-rule", precision: "EXACT" });
    expect(routing.geocode).not.toHaveBeenCalled();

    // Learning the same label again updates the rule instead of adding a second one.
    await service.learn({ sourceLabel: "seifert  bremen", company: "Seifert Logistics", street: "Musterweg 7", postalCode: "28197", city: "Bremen", latitude: 53.1, longitude: 8.75 }, actor);
    expect(await db.addressRule.count()).toBe(1);
    expect((await db.addressRule.findFirstOrThrow()).street).toBe("Musterweg 7");
  });

  it("asks the geocoder for the company in the city before the bare city", async () => {
    const queries: string[] = [];
    const routing = { geocode: vi.fn(async (query: string) => {
      queries.push(query);
      if (query === "Bremen") return { latitude: 53.08, longitude: 8.8, label: "Bremen", provider: "test" };
      if (query.startsWith("BLG")) return { latitude: 53.11, longitude: 8.74, label: "BLG, Bremen", provider: "test" };
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    }), route: vi.fn() };
    const resolved = await resolveAddressWithFallback(routing as never, { address: "Bremen", city: "HB", company: "BLG" }, undefined, BUILT_IN_RULES);
    expect(queries[0]).toBe("BLG, Bremen");
    expect(resolved).toMatchObject({ latitude: 53.11, precision: "POSTCODE_CITY" });
  });
});
