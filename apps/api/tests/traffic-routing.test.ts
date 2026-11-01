import { describe, expect, it, vi } from "vitest";
import type { Coordinate, RouteResult } from "../src/domain.js";
import { RoutingError, type RoutingProvider } from "../src/services/routing.js";
import {
  PrismaTrafficQuotaStore,
  TomTomRoutingProvider,
  TrafficRoutingService,
  type TrafficQuotaStore
} from "../src/services/traffic-routing.js";

const origin: Coordinate = { latitude: 52.52, longitude: 13.405 };
const destination: Coordinate = { latitude: 53.5511, longitude: 9.9937 };

describe("TomTomRoutingProvider", () => {
  it("uses OSRM fallback with explicit no-traffic metadata when no key is configured", async () => {
    const fetchMock = vi.fn();
    const fallback = fakeFallback();
    const provider = new TomTomRoutingProvider(alwaysQuota(), fallback, fetchMock, {
      apiKey: undefined,
      freeTierConfirmed: true
    });

    const route = await provider.calculateRoute(origin, destination);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(route.provider).toBe("osrm");
    expect(route.providerStatus).toBe("not-configured");
    expect(route.warning).toBe("Без актуальных пробок и проверки ограничений для грузовиков.");
  });

  it("consumes free quota before every TomTom network route request and sends truck traffic params", async () => {
    const quota = { consume: vi.fn(async () => ({ id: "tomtom-routing:2026-10", used: 1, limit: 18_000, reservedForManual: 3_600, availableForSource: 17_999, updatedAt: new Date() })) };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tomTomResponse()));
    const provider = new TomTomRoutingProvider(quota, fakeFallback(), fetchMock, {
      apiKey: "test-key",
      freeTierConfirmed: true,
      baseUrl: "https://api.tomtom.test/"
    });

    const route = await provider.calculateRoute(origin, destination, {
      source: "background",
      maxAlternatives: 2,
      includeInstructions: true,
      truck: { heightMeters: 4, widthMeters: 2.55, lengthMeters: 13.6, weightKg: 40_000 }
    });

    expect(quota.consume).toHaveBeenCalledWith("background", expect.any(Date));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestedUrl.pathname).toBe("/routing/1/calculateRoute/52.52,13.405:53.5511,9.9937/json");
    expect(requestedUrl.searchParams.get("key")).toBe("test-key");
    expect(requestedUrl.searchParams.get("traffic")).toBe("true");
    expect(requestedUrl.searchParams.get("travelMode")).toBe("truck");
    expect(requestedUrl.searchParams.get("routeType")).toBe("fastest");
    expect(requestedUrl.searchParams.get("computeTravelTimeFor")).toBe("all");
    expect(requestedUrl.searchParams.get("vehicleHeight")).toBe("4");
    expect(requestedUrl.searchParams.get("vehicleWeight")).toBe("40000");
    expect(route.provider).toBe("tomtom");
    expect(route.providerStatus).toBe("live-traffic");
    expect(route.trafficDelaySeconds).toBe(900);
    expect(route.noTrafficDurationSeconds).toBe(6_200);
    expect(route.roadNumbers).toEqual(["A24", "A1"]);
    expect(route.instructions[0]).toMatchObject({ message: "Auf A24 fahren", roadNumber: "A24" });
    expect(route.hasRoadClosure).toBe(false);
    expect(route.alternatives).toHaveLength(1);
    expect(route.alternatives[0].trafficDelaySeconds).toBe(300);
  });

  it("does not call TomTom when the persistent free quota rejects the request", async () => {
    const quota = { consume: vi.fn(async () => { throw new RoutingError("quota", 429); }) };
    const fetchMock = vi.fn();
    const provider = new TomTomRoutingProvider(quota, fakeFallback(), fetchMock, {
      apiKey: "test-key",
      freeTierConfirmed: true
    });

    await expect(provider.calculateRoute(origin, destination, { source: "manual" })).resolves.toMatchObject({ providerStatus: "quota-exhausted", provider: "osrm" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reconstructs the accepted route with POST, retaining alternatives separately", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tomTomResponse()));
    const provider = new TomTomRoutingProvider(alwaysQuota(), fakeFallback(), fetchMock, { apiKey: "test", freeTierConfirmed: true });
    const points = [origin, { latitude: 53, longitude: 12 }, destination];
    const result = await provider.evaluateStoredRoute(points, destination, { maxAlternatives: 2 });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ supportingPoints: points }) });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("instructionsType")).toBe("text");
    expect(result.geometry).toEqual(points);
    expect(result.alternatives).toHaveLength(1);
  });

  it("fails closed without explicit free-tier confirmation, even if enabled", async () => {
    const fetchMock = vi.fn();
    const provider = new TomTomRoutingProvider(alwaysQuota(), fakeFallback(), fetchMock, { apiKey: "test", enabled: true, freeTierConfirmed: false });
    expect((await provider.calculateRoute(origin, destination)).providerStatus).toBe("not-configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed network routes and labels fallback without live traffic", async () => {
    const provider = new TomTomRoutingProvider(alwaysQuota(), fakeFallback(), vi.fn().mockResolvedValue(jsonResponse({ routes: [{}] })), { apiKey: "test", freeTierConfirmed: true });
    const result = await provider.calculateRoute(origin, destination);
    expect(result.providerStatus).toBe("fallback-no-traffic");
    expect(result.warning).toContain("Без актуальных пробок");
  });
});

describe("TomTomRoutingProvider quota refunds", () => {
  const config = { apiKey: "test-key", freeTierConfirmed: true };
  const refundingQuota = () => ({
    consume: vi.fn(async (_source: string, _now?: Date) => ({ id: "t", used: 1, limit: 18_000, reservedForManual: 3_600, availableForSource: 17_999, updatedAt: new Date() })),
    refund: vi.fn(async () => undefined)
  });

  it.each([
    ["network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["timeout", () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }))],
    ["HTTP 400", () => Promise.resolve(new Response("", { status: 400 }))],
    ["HTTP 401", () => Promise.resolve(new Response("", { status: 401 }))],
    ["HTTP 403", () => Promise.resolve(new Response("", { status: 403 }))]
  ])("refunds one quota unit after a %s", async (_label, fetchImpl) => {
    const quota = refundingQuota();
    const provider = new TomTomRoutingProvider(quota, fakeFallback(), vi.fn(fetchImpl), config);
    const route = await provider.calculateMultiStopRoute([origin, destination], { source: "background" });
    expect(route.providerStatus).toBe("fallback-no-traffic");
    expect(quota.refund).toHaveBeenCalledTimes(1);
    expect(quota.refund).toHaveBeenCalledWith("background", quota.consume.mock.calls[0][1]);
  });

  it.each([
    ["HTTP 500", () => Promise.resolve(new Response("", { status: 500 }))],
    ["HTTP 429", () => Promise.resolve(new Response("", { status: 429 }))],
    ["malformed route", () => Promise.resolve(jsonResponse({ routes: [] }))]
  ])("keeps the quota unit after a billed %s", async (_label, fetchImpl) => {
    const quota = refundingQuota();
    const provider = new TomTomRoutingProvider(quota, fakeFallback(), vi.fn(fetchImpl), config);
    await provider.calculateRoute(origin, destination);
    expect(quota.refund).not.toHaveBeenCalled();
  });

  it("still falls back when the refund itself fails", async () => {
    const quota = { ...refundingQuota(), refund: vi.fn(async () => { throw new Error("db down"); }) };
    const provider = new TomTomRoutingProvider(quota, fakeFallback(), vi.fn().mockRejectedValue(new TypeError("fetch failed")), config);
    await expect(provider.calculateRoute(origin, destination)).resolves.toMatchObject({ provider: "osrm", providerStatus: "fallback-no-traffic" });
  });

  it("reports a quota store failure separately from a TomTom outage", async () => {
    const quota = { consume: vi.fn(async () => { throw new Error("connection refused"); }), refund: vi.fn() };
    const fetchMock = vi.fn();
    const provider = new TomTomRoutingProvider(quota, fakeFallback(), fetchMock, config);
    const route = await provider.calculateRoute(origin, destination);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(quota.refund).not.toHaveBeenCalled();
    expect(route.providerStatus).toBe("quota-unavailable");
    expect(route.warning).toContain("Не удалось проверить квоту TomTom.");
    expect(route.warning).not.toContain("временно недоступен");
    expect(route.warning).not.toContain("connection refused");
  });
});

describe("TrafficRoutingService", () => {
  it("returns current route refresh data and keeps alternative reroutes as dispatcher proposals", async () => {
    const quota = {
      consume: vi.fn(async () => ({ id: "tomtom-routing:2026-10", used: 2, limit: 18_000, reservedForManual: 3_600, availableForSource: 14_398, updatedAt: new Date() })),
      getStatus: vi.fn(async () => ({ id: "tomtom-routing:2026-10", used: 2, limit: 18_000, reservedForManual: 3_600, availableForSource: 14_398, updatedAt: new Date() }))
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(tomTomResponse({
      primaryTravelTimeSeconds: 7_300,
      alternativeTravelTimeSeconds: 6_500
    })));
    const provider = new TomTomRoutingProvider(quota, fakeFallback(), fetchMock, {
      apiKey: "test-key",
      freeTierConfirmed: true,
      baseUrl: "https://api.tomtom.test/"
    });
    const service = new TrafficRoutingService(provider, quota);

    const refresh = await service.refreshCurrentRoute({
      origin,
      destination,
      options: { source: "background" }
    });

    expect(refresh.activeRoute.durationSeconds).toBe(7_300);
    expect(refresh.alternatives).toHaveLength(1);
    expect(refresh.alternatives[0]).toMatchObject({
      reason: "traffic-delay",
      timeSavingSeconds: 800,
      roadNumbers: ["A7"]
    });
    expect(refresh.quota?.availableForSource).toBe(14_398);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("PrismaTrafficQuotaStore", () => {
  it("hard caps at 18000, fails closed on invalid configuration and resets by month", async () => {
    const delegate = quotaDelegate({ "tomtom-routing:2026-10": { used: 18000, updatedAt: new Date() } });
    const client = { $transaction: async <T>(callback: (tx: { apiQuota: typeof delegate }) => Promise<T>) => callback({ apiQuota: delegate }) };
    const store = new PrismaTrafficQuotaStore(client, { monthlyCap: 100000 });
    await expect(store.consume("manual", new Date("2026-10-10"))).rejects.toMatchObject({ statusCode: 429 });
    expect((await store.consume("manual", new Date("2026-11-01"))).used).toBe(1);
    const invalid = new PrismaTrafficQuotaStore(client, { monthlyCap: Number.NaN });
    await expect(invalid.consume("manual", new Date("2026-12-01"))).rejects.toMatchObject({ statusCode: 429 });
  });
  it("reserves the configured part of the free quota for manual dispatcher actions", async () => {
    const delegate = quotaDelegate({ "tomtom-routing:2026-10": { used: 14_400, updatedAt: new Date("2026-10-10T00:00:00Z") } });
    const store = new PrismaTrafficQuotaStore({ $transaction: async (callback) => callback({ apiQuota: delegate }) }, {
      monthlyCap: 18_000,
      manualReserveRatio: 0.2
    });

    await expect(store.consume("background", new Date("2026-10-10T12:00:00Z"))).rejects.toMatchObject({ statusCode: 429 });

    const manual = await store.consume("manual", new Date("2026-10-10T12:00:00Z"));
    expect(manual.used).toBe(14_401);
    expect(manual.reservedForManual).toBe(3_600);
  });
  it("reserves the last available request atomically under parallel calls", async () => {
    const delegate = quotaDelegate({ "tomtom-routing:2026-10": { used: 17_999, updatedAt: new Date("2026-10-10T00:00:00Z") } });
    const store = new PrismaTrafficQuotaStore({ $transaction: async (callback) => callback({ apiQuota: delegate }) }, { monthlyCap: 18_000 });
    const results = await Promise.allSettled([
      store.consume("manual", new Date("2026-10-10T12:00:00Z")),
      store.consume("manual", new Date("2026-10-10T12:00:00Z"))
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await store.getStatus("manual", new Date("2026-10-10T12:00:00Z"))).used).toBe(18_000);
  });
  it("refunds one unit in the month it was consumed and never goes below zero", async () => {
    const delegate = quotaDelegate({ "tomtom-routing:2026-10": { used: 1, updatedAt: new Date("2026-10-10T00:00:00Z") } });
    const store = new PrismaTrafficQuotaStore({ $transaction: async (callback) => callback({ apiQuota: delegate }) }, { monthlyCap: 18_000 });
    const at = new Date("2026-10-10T12:00:00Z");
    await store.refund("manual", at);
    await store.refund("manual", at);
    expect((await store.getStatus("manual", at)).used).toBe(0);
    await store.refund("manual", new Date("2026-11-10T12:00:00Z"));
    expect((await store.getStatus("manual", new Date("2026-11-10T12:00:00Z"))).used).toBe(0);
  });
});

function fakeFallback(): RoutingProvider {
  const route: RouteResult = {
    geometry: [origin, destination],
    distanceMeters: 300_000,
    durationSeconds: 14_000,
    provider: "osrm"
  };
  return {
    async geocode(address: string) {
      return { label: address, latitude: 52, longitude: 13, provider: "test" };
    },
    async calculateRoute() {
      return route;
    },
    async calculateMultiStopRoute(stops: Coordinate[]) {
      return { ...route, geometry: stops };
    }
  };
}

function alwaysQuota(): TrafficQuotaStore {
  return {
    async consume() {
      return { id: "test", used: 1, limit: 18_000, reservedForManual: 3_600, availableForSource: 17_999, updatedAt: new Date() };
    }
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function tomTomResponse(overrides: { primaryTravelTimeSeconds?: number; alternativeTravelTimeSeconds?: number } = {}) {
  return {
    routes: [
      {
        summary: {
          lengthInMeters: 286_000,
          travelTimeInSeconds: overrides.primaryTravelTimeSeconds ?? 7_100,
          trafficDelayInSeconds: 900,
          noTrafficTravelTimeInSeconds: 6_200,
          historicTrafficTravelTimeInSeconds: 6_900,
          liveTrafficIncidentsTravelTimeInSeconds: 7_100
        },
        legs: [{ points: [origin, { latitude: 53, longitude: 12 }, destination] }],
        sections: [{ sectionType: "ROAD_SHIELDS", roadShieldReferences: [{ shieldContent: "A24" }, { shieldContent: "A1" }] }],
        guidance: { instructions: [{ message: "Auf A24 fahren", roadNumbers: ["A24"], routeOffsetInMeters: 1000 }] }
      },
      {
        summary: {
          lengthInMeters: 295_000,
          travelTimeInSeconds: overrides.alternativeTravelTimeSeconds ?? 7_300,
          trafficDelayInSeconds: 300
        },
        legs: [{ points: [origin, destination] }],
        sections: [{ sectionType: "ROAD_SHIELDS", roadShieldReferences: [{ shieldContent: "A7" }] }]
      }
    ]
  };
}

function quotaDelegate(initial: Record<string, { used: number; updatedAt: Date }>) {
  const rows = new Map(Object.entries(initial));
  return {
    async findUnique({ where }: { where: { id: string } }) {
      const row = rows.get(where.id);
      return row ? { id: where.id, ...row } : null;
    },
    async upsert({ where, create }: { where: { id: string }; create: { id: string; used: number }; update: Record<string, never> }) {
      const existing = rows.get(where.id);
      if (existing) return { id: where.id, ...existing };
      const row = { used: create.used, updatedAt: new Date("2026-10-10T12:00:00Z") };
      rows.set(create.id, row);
      return { id: create.id, ...row };
    },
    async updateMany({ where, data }:
      | { where: { id: string; used: { lt: number } }; data: { used: { increment: number } } }
      | { where: { id: string; used: { gt: number } }; data: { used: { decrement: number } } }) {
      const current = rows.get(where.id);
      if (!current) return { count: 0 };
      if ("lt" in where.used && current.used >= where.used.lt) return { count: 0 };
      if ("gt" in where.used && current.used <= where.used.gt) return { count: 0 };
      const delta = "increment" in data.used ? data.used.increment : -data.used.decrement;
      const row = { used: current.used + delta, updatedAt: new Date("2026-10-10T12:00:00Z") };
      rows.set(where.id, row);
      return { count: 1 };
    }
  };
}
