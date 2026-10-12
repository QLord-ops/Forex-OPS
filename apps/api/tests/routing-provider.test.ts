import { describe, expect, it, vi } from "vitest";
import { OsrmRoutingProvider } from "../src/services/routing.js";

describe("OsrmRoutingProvider", () => {
  it("does not confirm an address with invented coordinates when Nominatim is unavailable", async () => {
    const provider = new OsrmRoutingProvider(undefined, vi.fn().mockRejectedValue(new Error("offline")), {
      allowMock: false,
      nominatimMinIntervalMs: 0
    });

    await expect(provider.geocode("Unbekannte Straße 1")).rejects.toMatchObject({ statusCode: 502 });
  });

  it("uses the explicit demo fallback only when ROUTING_ALLOW_MOCK is enabled", async () => {
    const provider = new OsrmRoutingProvider(undefined, vi.fn().mockRejectedValue(new Error("offline")), {
      allowMock: true,
      nominatimMinIntervalMs: 0
    });

    await expect(provider.geocode("Göttingen")).resolves.toMatchObject({ provider: "mock", city: "Гёттинген" });
  });

  it("caches equal geocode requests and returns real Nominatim coordinates", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{
        lat: "51.5413",
        lon: "9.9158",
        display_name: "Göttingen, Deutschland",
        address: { town: "Göttingen" }
      }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const provider = new OsrmRoutingProvider(undefined, fetchMock, {
      allowMock: false,
      nominatimMinIntervalMs: 0
    });

    const first = await provider.geocode(" Göttingen ");
    const second = await provider.geocode("göttingen");

    expect(first).toEqual(second);
    expect(first.provider).toBe("nominatim");
    expect(first).toMatchObject({ city: "Göttingen" });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("addressdetails")).toBe("1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
