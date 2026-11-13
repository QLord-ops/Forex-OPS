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

  it("falls back to postcode and city, and to the bare city only when no postcode was printed", () => {
    expect(buildAddressCandidates("Sickingenstr. 28-38, D 10553 Berlin", "Berlin")).toEqual([
      { query: "Sickingenstraße 28-38, 10553 Berlin", precision: "EXACT" },
      { query: "Sickingenstraße, 10553 Berlin", precision: "STREET" },
      { query: "10553 Berlin", precision: "POSTCODE_CITY" }
    ]);
    expect(buildAddressCandidates("Sickingenstr. 28-38, Berlin", "Berlin").at(-1)).toEqual({ query: "Berlin", precision: "CITY" });
  });

  describe("a town name shared by several towns (Petershagen, 13.11)", () => {
    const westfalen = { latitude: 52.38, longitude: 8.97 };
    const brandenburg = { latitude: 52.53, longitude: 13.79 };

    it("puts the postcode of the city field into every query", () => {
      expect(buildAddressCandidates("Industriestraße 12, Petershagen", "32469 Petershagen")).toEqual([
        { query: "Industriestraße 12, 32469 Petershagen", precision: "EXACT" },
        { query: "Industriestraße, 32469 Petershagen", precision: "STREET" },
        { query: "32469 Petershagen", precision: "POSTCODE_CITY" }
      ]);
      expect(buildAddressCandidates("Petershagener Straße 4", "32469 Petershagen")[0])
        .toEqual({ query: "Petershagener Straße 4, 32469 Petershagen", precision: "EXACT" });
      expect(buildAddressCandidates("Petershagen", "D-32469 Petershagen", "Muster Logistik")).toEqual([
        { query: "Muster Logistik, 32469 Petershagen", precision: "POSTCODE_CITY" },
        { query: "32469 Petershagen", precision: "POSTCODE_CITY" }
      ]);
    });

    it("drops the namesake with another postcode even though the town name matches", async () => {
      const geocode = vi.fn(async (query: string) => {
        if (query === "Industriestraße 12, 32469 Petershagen") {
          return { label: "Industriestraße 12, 15370 Petershagen/Eggersdorf", city: "Petershagen", postalCode: "15370", ...brandenburg, provider: "nominatim" };
        }
        if (query === "Industriestraße, 32469 Petershagen") {
          return { label: "Industriestraße, 32469 Petershagen", city: "Petershagen", postalCode: "32469", latitude: 52.39, longitude: 8.95, provider: "nominatim" };
        }
        if (query === "32469 Petershagen") return { label: "32469 Petershagen", city: "Petershagen", postalCode: "32469", ...westfalen, provider: "nominatim" };
        throw new RoutingError("Адрес не найден.", 404);
      });

      const result = await resolveAddressWithFallback({ geocode } as unknown as RoutingProvider, { address: "Industriestraße 12", city: "32469 Petershagen" });

      expect(result).toMatchObject({ latitude: 52.39, longitude: 8.95, precision: "STREET" });
      expect(result.attempts.some((attempt) => attempt.includes("15370") && attempt.includes("отброшено"))).toBe(true);
    });

    it("keeps another postcode of the same town when it lies inside the town", async () => {
      const geocode = vi.fn(async (query: string) => {
        if (query === "32469 Petershagen") return { label: "32469 Petershagen", city: "Petershagen", postalCode: "32469", ...westfalen, provider: "nominatim" };
        return { label: "Mindener Straße 1, 32457 Petershagen", city: "Petershagen", postalCode: "32457", latitude: 52.36, longitude: 8.99, provider: "nominatim" };
      });

      const result = await resolveAddressWithFallback({ geocode } as unknown as RoutingProvider, { address: "Mindener Straße 1, 32469 Petershagen", city: "Petershagen" });

      expect(result).toMatchObject({ latitude: 52.36, precision: "EXACT" });
    });
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
