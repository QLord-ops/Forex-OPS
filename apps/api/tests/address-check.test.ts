import { describe, expect, it, vi } from "vitest";
import { OpenPlzChecker, TomTomPlaceSearch, addressParts } from "../src/services/address-check.js";
import { resolveAddressWithFallback } from "../src/services/address-resolution.js";
import type { RoutingProvider } from "../src/services/routing.js";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function openPlz(localities: Record<string, string[]>, streets: Record<string, string[]>) {
  return vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const postalCode = url.searchParams.get("postalCode")!;
    if (url.pathname.endsWith("/de/Localities")) return reply((localities[postalCode] ?? []).map((name) => ({ name })));
    const prefix = (url.searchParams.get("name") ?? "").toLowerCase();
    return reply((streets[postalCode] ?? []).filter((name) => name.toLowerCase().startsWith(prefix)).map((name) => ({ name })));
  }) as unknown as typeof fetch;
}

describe("address parts", () => {
  it("takes the street with a house number, the postcode and the town", () => {
    expect(addressParts("Industriestraße 5, D-38239 Salzgitter")).toEqual({ street: "Industriestraße", postalCode: "38239", city: "Salzgitter" });
    expect(addressParts("Werk 2, 38239", "Salzgitter").city).toBe("Salzgitter");
    expect(addressParts("BLG", "28197 Bremen")).toEqual({ street: undefined, postalCode: "28197", city: "Bremen" });
  });
});

describe("OpenPLZ check", () => {
  const fetchImpl = openPlz({ "38239": ["Salzgitter"], "38440": ["Wolfsburg"] }, { "38239": ["Industriestr. Mitte", "Industriestr. Nord"], "38440": ["Berliner Ring"] });
  const checker = new OpenPlzChecker(fetchImpl, "https://plz.test/");

  it("accepts a street written in full against the register's short form", async () => {
    expect(await checker.check({ address: "Industriestraße Nord 1, 38239 Salzgitter" })).toMatchObject({ status: "OK" });
    expect(await checker.check({ address: "Berliner Ring 2, 38440 Wolfsburg" })).toMatchObject({ status: "OK" });
  });

  it("names the town of a postcode that does not belong to the printed city", async () => {
    const check = await checker.check({ address: "Berliner Ring 2, 38239", city: "Wolfsburg" });
    expect(check).toMatchObject({ status: "POSTCODE_NOT_IN_CITY", message: "Индекс 38239 — это Salzgitter, а не Wolfsburg. Проверьте индекс или город." });
  });

  it("flags a street that is not at the postcode and a postcode that does not exist", async () => {
    expect(await checker.check({ address: "Berliner Ring 2, 38239 Salzgitter" })).toMatchObject({ status: "STREET_NOT_IN_POSTCODE" });
    expect(await checker.check({ address: "Hauptstraße 1, 99999 Nirgendwo" })).toMatchObject({ status: "UNKNOWN_POSTCODE" });
  });

  it("an outage or no postcode means not checked, never an alarm", async () => {
    const down = new OpenPlzChecker(vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch, "https://plz.test/");
    expect(await down.check({ address: "Berliner Ring 2, 38440 Wolfsburg" })).toBeNull();
    expect(await checker.check({ address: "Berliner Ring 2", city: "Wolfsburg" })).toBeNull();
  });
});

describe("TomTom company search", () => {
  const near = { latitude: 53.1, longitude: 8.8 };
  const result = { poi: { name: "BLG Logistics Group" }, position: { lat: 53.12, lon: 8.75 }, address: { freeformAddress: "Senator-Borttscheller-Straße 1, 28197 Bremen", municipality: "Bremen", postalCode: "28197" } };

  it("is off without the key or the free-tier confirmation", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await new TomTomPlaceSearch(fetchImpl, { apiKey: "", enabled: true }).findCompany("BLG", near)).toBeNull();
    expect(await new TomTomPlaceSearch(fetchImpl, { apiKey: "k", enabled: false }).findCompany("BLG", near)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("takes only a hit whose name matches the company, asks once per company and town and keeps a daily cap", async () => {
    const fetchImpl = vi.fn(async () => reply({ results: [{ ...result, poi: { name: "Bäckerei Müller" } }, result] })) as unknown as typeof fetch;
    const search = new TomTomPlaceSearch(fetchImpl, { apiKey: "k", enabled: true, baseUrl: "https://tt.test/", dailyCap: 2 });
    expect(await search.findCompany("BLG Logistics", near)).toMatchObject({ label: "BLG Logistics Group, Senator-Borttscheller-Straße 1, 28197 Bremen", provider: "tomtom-search", postalCode: "28197" });
    await search.findCompany("BLG Logistics", near);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await search.findCompany("Seifert", near);
    expect(await search.findCompany("Rhenus", near)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("resolution with the register and company search", () => {
  const town = { label: "Bremen", city: "Bremen", latitude: 53.08, longitude: 8.8, provider: "nominatim" };

  it("a company without a street is found in the business directory near its town", async () => {
    const routing = { geocode: vi.fn(async () => town) } as unknown as RoutingProvider;
    const places = { findCompany: vi.fn(async () => ({ label: "BLG, 28197 Bremen", latitude: 53.12, longitude: 8.75, city: "Bremen", provider: "tomtom-search" })) };
    const resolved = await resolveAddressWithFallback(routing, { address: "Bremen", city: "Bremen", company: "BLG" }, undefined, [], [], { places });
    expect(resolved).toMatchObject({ provider: "tomtom-search", precision: "EXACT", resolvedAddress: "BLG, 28197 Bremen" });
  });

  it("a business hit in another town is dropped and the usual search goes on", async () => {
    const routing = { geocode: vi.fn(async () => town) } as unknown as RoutingProvider;
    const places = { findCompany: vi.fn(async () => ({ label: "BLG, München", latitude: 48.1, longitude: 11.6, city: "München", provider: "tomtom-search" })) };
    const resolved = await resolveAddressWithFallback(routing, { address: "Bremen", city: "Bremen", company: "BLG" }, undefined, [], [], { places });
    expect(resolved.provider).toBe("nominatim");
    expect(resolved.attempts.some((item) => item.includes("отброшено"))).toBe(true);
  });

  it("an address with a house number is not sent to the business search, and the register verdict comes with it", async () => {
    const routing = { geocode: vi.fn(async () => ({ label: "Berliner Ring 2, Wolfsburg", city: "Wolfsburg", latitude: 52.43, longitude: 10.79, provider: "nominatim" })) } as unknown as RoutingProvider;
    const places = { findCompany: vi.fn() };
    const checker = { check: vi.fn(async () => ({ status: "POSTCODE_NOT_IN_CITY" as const, message: "Индекс 38239 — это Salzgitter, а не Wolfsburg." })) };
    const resolved = await resolveAddressWithFallback(routing, { address: "Berliner Ring 2, 38239 Wolfsburg", city: "Wolfsburg", company: "VW" }, undefined, [], [], { places, checker });
    expect(places.findCompany).not.toHaveBeenCalled();
    expect(resolved.check?.status).toBe("POSTCODE_NOT_IN_CITY");
  });
});
