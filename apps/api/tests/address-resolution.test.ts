import { describe, expect, it, vi } from "vitest";
import { buildAddressCandidates, resolveAddressWithFallback } from "../src/services/address-resolution.js";
import { RoutingError, type RoutingProvider } from "../src/services/routing.js";

describe("address resolution fallback", () => {
  it("normalizes German postal prefixes and falls back from house number to street", async () => {
    const geocode = vi.fn(async (query: string) => {
      if (query.includes(" 2")) throw new RoutingError("Адрес не найден.", 404);
      return { label: "Rudolf-Diesel-Straße, 14974 Ludwigsfelde, Deutschland", city: "Ludwigsfelde", latitude: 52.3, longitude: 13.2, provider: "nominatim" };
    });
    const routing = { geocode } as unknown as RoutingProvider;

    const result = await resolveAddressWithFallback(routing, {
      address: "Rudolf-Diesel-Straße 2, D 14974 Ludwigsfelde",
      city: "Ludwigsfelde"
    });

    expect(result.precision).toBe("STREET");
    expect(result.sourceAddress).toContain("Straße 2");
    expect(geocode.mock.calls.map(([query]) => query)).toEqual([
      "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde",
      "Rudolf-Diesel-Straße, 14974 Ludwigsfelde"
    ]);
  });

  it("falls back to postcode and city, then to city", () => {
    expect(buildAddressCandidates("Sickingenstr. 28-38, D 10553 Berlin", "Berlin")).toEqual([
      { query: "Sickingenstraße 28-38, 10553 Berlin", precision: "EXACT" },
      { query: "Sickingenstraße, 10553 Berlin", precision: "STREET" },
      { query: "10553 Berlin", precision: "POSTCODE_CITY" },
      { query: "Berlin", precision: "CITY" }
    ]);
  });

  it("does not hide a provider outage behind an approximate city result", async () => {
    const routing = { geocode: vi.fn().mockRejectedValue(new RoutingError("Сервис недоступен.", 502)) } as unknown as RoutingProvider;
    await expect(resolveAddressWithFallback(routing, { address: "Teststraße 1, 10115 Berlin", city: "Berlin" }))
      .rejects.toMatchObject({ statusCode: 502 });
    expect(routing.geocode).toHaveBeenCalledTimes(1);
  });

  it("uses controlled web research only after every free candidate is not found", async () => {
    const geocode = vi.fn(async (query: string) => {
      if (query === "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde") {
        return { label: query, city: "Ludwigsfelde", latitude: 52.3, longitude: 13.2, provider: "nominatim" };
      }
      throw new RoutingError("Адрес не найден.", 404);
    });
    const research = vi.fn().mockResolvedValue([{
      address: "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde",
      rationale: "Официальная страница площадки.",
      sourceUrls: ["https://example.com/location"]
    }]);

    const result = await resolveAddressWithFallback(
      { geocode } as unknown as RoutingProvider,
      { address: "Brose Lager, Ludwigsfelde", city: "Ludwigsfelde" },
      { research }
    );

    expect(research).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      resolvedAddress: "Rudolf-Diesel-Straße 2, 14974 Ludwigsfelde",
      researchUsed: true,
      provider: "openai-web+nominatim"
    });
  });

  it("prefers researched full address to a coarse city fallback", async () => {
    const geocode = vi.fn(async (query: string) => {
      if (query === "Berlin") return { label: "Berlin, Deutschland", city: "Berlin", latitude: 52.5, longitude: 13.4, provider: "nominatim" };
      if (query === "Sickingenstraße 28-38, 10553 Berlin") return { label: query, city: "Berlin", latitude: 52.53, longitude: 13.32, provider: "nominatim" };
      throw new RoutingError("Адрес не найден.", 404);
    });
    const research = vi.fn().mockResolvedValue([{
      address: "Sickingenstraße 28-38, 10553 Berlin",
      rationale: "Адрес площадки найден в интернете.",
      sourceUrls: ["https://example.com/berlin"]
    }]);

    const result = await resolveAddressWithFallback(
      { geocode } as unknown as RoutingProvider,
      { address: "Brose Berlin", city: "Berlin" },
      { research }
    );

    expect(result.researchUsed).toBe(true);
    expect(result.resolvedAddress).toContain("Sickingenstraße");
  });
});
