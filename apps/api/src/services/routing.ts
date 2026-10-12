import type { Coordinate, GeocodeResult, RouteResult } from "../domain.js";
import type { RouteRequestOptions } from "./traffic-routing.js";
import {
  calculateHaversineDistanceMeters,
  calculatePolylineDistanceMeters
} from "./simulation.js";

export interface RoutingProvider {
  geocode(address: string): Promise<GeocodeResult>;
  calculateRoute(origin: Coordinate, destination: Coordinate, options?: RouteRequestOptions): Promise<RouteResult>;
  calculateMultiStopRoute(stops: Coordinate[], options?: RouteRequestOptions): Promise<RouteResult>;
}

export class RoutingService implements RoutingProvider {
  constructor(private readonly provider: RoutingProvider) {}

  geocode(address: string): Promise<GeocodeResult> {
    return this.provider.geocode(address);
  }

  calculateRoute(origin: Coordinate, destination: Coordinate, options?: RouteRequestOptions): Promise<RouteResult> {
    return this.provider.calculateRoute(origin, destination, options);
  }

  calculateMultiStopRoute(stops: Coordinate[], options?: RouteRequestOptions): Promise<RouteResult> {
    return this.provider.calculateMultiStopRoute(stops, options);
  }
}

const KNOWN_ADDRESSES: Record<string, GeocodeResult> = {
  gottingen: { label: "Гёттинген, Германия", latitude: 51.5413, longitude: 9.9158, provider: "mock" },
  "göttingen": { label: "Гёттинген, Германия", latitude: 51.5413, longitude: 9.9158, provider: "mock" },
  zwickau: { label: "Цвиккау, Германия", latitude: 50.7189, longitude: 12.4961, provider: "mock" },
  leipzig: { label: "Лейпциг, Германия", latitude: 51.3397, longitude: 12.3731, provider: "mock" },
  hannover: { label: "Ганновер, Германия", latitude: 52.3759, longitude: 9.732, provider: "mock" },
  hamburg: { label: "Гамбург, Германия", latitude: 53.5511, longitude: 9.9937, provider: "mock" },
  kassel: { label: "Кассель, Германия", latitude: 51.3127, longitude: 9.4797, provider: "mock" },
  erfurt: { label: "Эрфурт, Германия", latitude: 50.9848, longitude: 11.0299, provider: "mock" },
  dortmund: { label: "Дортмунд, Германия", latitude: 51.5136, longitude: 7.4653, provider: "mock" },
  bremen: { label: "Бремен, Германия", latitude: 53.0793, longitude: 8.8017, provider: "mock" }
};

export class MockRoutingProvider implements RoutingProvider {
  async geocode(address: string): Promise<GeocodeResult> {
    const normalized = normalize(address);
    const known = Object.entries(KNOWN_ADDRESSES).find(([key]) => normalized.includes(key));
    if (known) return known[1];

    if (!address.trim()) {
      throw new Error("Адрес не может быть пустым.");
    }

    const hash = [...normalized].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return {
      label: address,
      latitude: 50.5 + (hash % 300) / 100,
      longitude: 7.5 + (hash % 600) / 100,
      provider: "mock"
    };
  }

  async calculateRoute(origin: Coordinate, destination: Coordinate, _options?: RouteRequestOptions): Promise<RouteResult> {
    const geometry = buildFallbackRoadGeometry(origin, destination);
    const distanceMeters = Math.max(
      Math.round(calculatePolylineDistanceMeters(geometry) * 1.18),
      Math.round(calculateHaversineDistanceMeters(origin, destination))
    );
    const durationSeconds = Math.ceil(distanceMeters / ((72 * 1000) / 3600));

    return {
      geometry,
      distanceMeters,
      durationSeconds,
      provider: "mock"
    };
  }

  async calculateMultiStopRoute(stops: Coordinate[], options?: RouteRequestOptions): Promise<RouteResult> {
    if (stops.length < 2) {
      return { geometry: stops, distanceMeters: 0, durationSeconds: 0, provider: "mock" };
    }

    const routes = await Promise.all(
      stops.slice(1).map((stop, index) => this.calculateRoute(stops[index], stop, options))
    );

    return mergeRoutes(routes, "mock");
  }
}

export class OsrmRoutingProvider implements RoutingProvider {
  private readonly allowMock: boolean;
  private readonly nominatimMinIntervalMs: number;
  private readonly userAgent: string;
  private readonly nominatimBaseUrl: string;
  private readonly osrmBaseUrl: string;
  private readonly geocodeCache = new Map<string, Promise<GeocodeResult>>();
  private geocodeQueue: Promise<void> = Promise.resolve();
  private lastGeocodeAt = 0;

  constructor(
    private readonly fallback: RoutingProvider = new MockRoutingProvider(),
    private readonly fetchImpl: typeof fetch = fetch,
    options: {
      allowMock?: boolean;
      nominatimMinIntervalMs?: number;
      userAgent?: string;
      nominatimBaseUrl?: string;
      osrmBaseUrl?: string;
    } = {}
  ) {
    this.allowMock = options.allowMock ?? process.env.ROUTING_ALLOW_MOCK === "true";
    this.nominatimMinIntervalMs = options.nominatimMinIntervalMs ?? 1_000;
    this.userAgent = options.userAgent ?? process.env.NOMINATIM_USER_AGENT ?? "ops-disponent-local/1.0";
    this.nominatimBaseUrl = withTrailingSlash(
      options.nominatimBaseUrl ?? process.env.NOMINATIM_BASE_URL ?? "https://nominatim.openstreetmap.org/"
    );
    this.osrmBaseUrl = withTrailingSlash(
      options.osrmBaseUrl ?? process.env.OSRM_BASE_URL ?? "https://router.project-osrm.org/"
    );
  }

  async geocode(address: string): Promise<GeocodeResult> {
    const query = address.trim();
    if (!query) throw new RoutingError("Адрес не может быть пустым.", 400);

    const cacheKey = normalize(query);
    const cached = this.geocodeCache.get(cacheKey);
    if (cached) return cached;

    const request = this.enqueueGeocode(query).catch((error) => {
      this.geocodeCache.delete(cacheKey);
      throw error;
    });
    this.geocodeCache.set(cacheKey, request);
    return request;
  }

  private enqueueGeocode(address: string): Promise<GeocodeResult> {
    const request = this.geocodeQueue.then(async () => {
      const waitMs = this.nominatimMinIntervalMs - (Date.now() - this.lastGeocodeAt);
      if (waitMs > 0) await delay(waitMs);
      this.lastGeocodeAt = Date.now();
      return this.fetchGeocode(address);
    });
    this.geocodeQueue = request.then(() => undefined, () => undefined);
    return request;
  }

  private async fetchGeocode(address: string): Promise<GeocodeResult> {
    try {
      const url = new URL("search", this.nominatimBaseUrl);
      url.searchParams.set("q", address);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");

      url.searchParams.set("addressdetails", "1");

      const data = (await this.fetchJsonWithTimeout(url)) as Array<{
        lat: string;
        lon: string;
        display_name: string;
        address?: {
          city?: string;
          town?: string;
          village?: string;
          municipality?: string;
        };
      }>;
      const first = data[0];
      if (!first) throw new RoutingError("Адрес не найден.", 404);
      if (!Number.isFinite(Number(first.lat)) || !Number.isFinite(Number(first.lon))
        || Math.abs(Number(first.lat)) > 90 || Math.abs(Number(first.lon)) > 180) {
        throw new RoutingError("Сервис адресов вернул некорректные координаты.", 502);
      }

      return {
        label: first.display_name,
        latitude: Number(first.lat),
        longitude: Number(first.lon),
        provider: "nominatim",
        city: first.address?.city ?? first.address?.town ?? first.address?.village ?? first.address?.municipality
      };
    } catch (error) {
      if (this.allowMock) return this.fallback.geocode(address);
      if (error instanceof RoutingError) throw error;
      throw new RoutingError("Сервис адресов временно недоступен.", 502);
    }
  }

  async calculateRoute(origin: Coordinate, destination: Coordinate, _options?: RouteRequestOptions): Promise<RouteResult> {
    try {
      const coords = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
      const url = new URL(`route/v1/driving/${coords}`, this.osrmBaseUrl);
      url.searchParams.set("overview", "full");
      url.searchParams.set("geometries", "geojson");

      const data = (await this.fetchJsonWithTimeout(url)) as {
        routes?: Array<{
          distance: number;
          duration: number;
          geometry: { coordinates: Array<[number, number]> };
        }>;
      };
      const route = data.routes?.[0];
      if (!route) throw new Error("OSRM не вернул маршрут.");

      return {
        geometry: route.geometry.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })),
        distanceMeters: Math.round(route.distance),
        durationSeconds: Math.ceil(route.duration),
        provider: "osrm"
      };
    } catch (error) {
      if (this.allowMock) return this.fallback.calculateRoute(origin, destination);
      if (error instanceof RoutingError) throw error;
      throw new RoutingError("Сервис маршрутизации временно недоступен.", 502);
    }
  }

  async calculateMultiStopRoute(stops: Coordinate[], options?: RouteRequestOptions): Promise<RouteResult> {
    if (stops.length < 2) {
      return { geometry: stops, distanceMeters: 0, durationSeconds: 0, provider: "osrm" };
    }

    const routes = [];
    for (let index = 1; index < stops.length; index += 1) {
      routes.push(await this.calculateRoute(stops[index - 1], stops[index], options));
    }
    return mergeRoutes(routes, routes.every((route) => route.provider === "osrm") ? "osrm" : "mixed");
  }

  private async fetchJsonWithTimeout(url: URL): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { "user-agent": this.userAgent }
      });
      if (!response.ok) throw new RoutingError(`Картографический сервис вернул статус ${response.status}.`, 502);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class RoutingError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "RoutingError";
  }
}

export function buildFallbackRoadGeometry(origin: Coordinate, destination: Coordinate): Coordinate[] {
  const midLatitude = (origin.latitude + destination.latitude) / 2;
  const midLongitude = (origin.longitude + destination.longitude) / 2;
  const bend = Math.max(0.08, Math.abs(destination.longitude - origin.longitude) * 0.12);

  return [
    origin,
    { latitude: origin.latitude + (midLatitude - origin.latitude) * 0.55, longitude: midLongitude - bend },
    { latitude: midLatitude + 0.04, longitude: midLongitude + bend },
    { latitude: destination.latitude - (destination.latitude - midLatitude) * 0.35, longitude: destination.longitude - bend / 2 },
    destination
  ];
}

function mergeRoutes(routes: RouteResult[], provider: string): RouteResult {
  return routes.reduce<RouteResult>(
    (merged, route, index) => ({
      geometry: merged.geometry.concat(index === 0 ? route.geometry : route.geometry.slice(1)),
      distanceMeters: merged.distanceMeters + route.distanceMeters,
      durationSeconds: merged.durationSeconds + route.durationSeconds,
      provider
    }),
    { geometry: [], distanceMeters: 0, durationSeconds: 0, provider }
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
