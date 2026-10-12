import type { Coordinate, RouteResult } from "../domain.js";
import { OsrmRoutingProvider, RoutingError, type RoutingProvider } from "./routing.js";

export type TrafficRefreshSource = "manual" | "background";

export type TruckRouteProfile = {
  heightMeters?: number;
  widthMeters?: number;
  lengthMeters?: number;
  weightKg?: number;
  axleWeightKg?: number;
  maxSpeedKmh?: number;
};

export type RouteRequestOptions = {
  departureTime?: Date;
  traffic?: boolean;
  maxAlternatives?: number;
  includeInstructions?: boolean;
  language?: string;
  source?: TrafficRefreshSource;
  supportingPoints?: Coordinate[];
  truck?: TruckRouteProfile;
};

export type RouteInstruction = {
  message: string;
  roadNumber?: string;
  exitNumber?: string;
  street?: string;
  distanceMeters?: number;
  travelTimeSeconds?: number;
};

export type TrafficProviderStatus =
  | "live-traffic"
  | "quota-exhausted"
  | "not-configured"
  | "fallback-no-traffic";

export type TrafficRouteResult = RouteResult & {
  checkedAt: string;
  trafficDelaySeconds: number;
  noTrafficDurationSeconds?: number;
  historicTrafficDurationSeconds?: number;
  liveTrafficDurationSeconds?: number;
  roadNumbers: string[];
  instructions: RouteInstruction[];
  alternatives: TrafficRouteResult[];
  hasRoadClosure: boolean;
  providerStatus: TrafficProviderStatus;
  warning?: string;
};

export type TomTomRoutingConfig = {
  apiKey?: string;
  freeTierConfirmed?: boolean;
  monthlyCap?: number;
  manualReserveRatio?: number;
  baseUrl?: string;
  language?: string;
  enabled?: boolean;
};

export type TrafficQuotaSnapshot = {
  id: string;
  used: number;
  limit: number;
  reservedForManual: number;
  availableForSource: number;
  updatedAt: Date;
};

export interface TrafficQuotaStore {
  consume(source: TrafficRefreshSource, now?: Date): Promise<TrafficQuotaSnapshot>;
  getStatus?(source?: TrafficRefreshSource, now?: Date): Promise<TrafficQuotaSnapshot>;
}

type ApiQuotaRecord = {
  id: string;
  used: number;
  updatedAt: Date;
};

type ApiQuotaDelegate = {
  findUnique(args: { where: { id: string } }): Promise<ApiQuotaRecord | null>;
  create(args: { data: { id: string; used: number } }): Promise<ApiQuotaRecord>;
  update(args: { where: { id: string }; data: { used: { increment: number } } }): Promise<ApiQuotaRecord>;
};

type PrismaLikeQuotaClient = {
  $transaction<T>(callback: (tx: { apiQuota: ApiQuotaDelegate }) => Promise<T>): Promise<T>;
};

export class PrismaTrafficQuotaStore implements TrafficQuotaStore {
  constructor(
    private readonly prisma: PrismaLikeQuotaClient,
    private readonly options: { namespace?: string; monthlyCap?: number; manualReserveRatio?: number } = {}
  ) {}

  async consume(source: TrafficRefreshSource, now = new Date()): Promise<TrafficQuotaSnapshot> {
    const status = quotaSettings(this.options, source, now);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.apiQuota.findUnique({ where: { id: status.id } });
      const used = existing?.used ?? 0;
      if (used >= status.sourceLimit) {
        throw new RoutingError("Бесплатная квота TomTom для этого типа запроса исчерпана.", 429);
      }

      const record = existing
        ? await tx.apiQuota.update({ where: { id: status.id }, data: { used: { increment: 1 } } })
        : await tx.apiQuota.create({ data: { id: status.id, used: 1 } });

      return {
        id: status.id,
        used: record.used,
        limit: status.monthlyCap,
        reservedForManual: status.reservedForManual,
        availableForSource: Math.max(0, status.sourceLimit - record.used),
        updatedAt: record.updatedAt
      };
    });
  }

  async getStatus(source: TrafficRefreshSource = "manual", now = new Date()): Promise<TrafficQuotaSnapshot> {
    const status = quotaSettings(this.options, source, now);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.apiQuota.findUnique({ where: { id: status.id } });
      return {
        id: status.id,
        used: existing?.used ?? 0,
        limit: status.monthlyCap,
        reservedForManual: status.reservedForManual,
        availableForSource: Math.max(0, status.sourceLimit - (existing?.used ?? 0)),
        updatedAt: existing?.updatedAt ?? now
      };
    });
  }
}

export type RouteAlternativeProposal = {
  route: TrafficRouteResult;
  reason: "traffic-delay" | "road-closure";
  timeSavingSeconds: number;
  extraDistanceMeters: number;
  roadNumbers: string[];
};

export type TrafficRouteRefreshInput = {
  origin: Coordinate;
  destination: Coordinate;
  supportingPoints?: Coordinate[];
  options?: RouteRequestOptions;
};

export type TrafficRouteRefreshResult = {
  activeRoute: TrafficRouteResult;
  alternatives: RouteAlternativeProposal[];
  quota?: TrafficQuotaSnapshot;
};

export class TrafficRoutingService {
  constructor(
    private readonly provider: TomTomRoutingProvider,
    private readonly quotaStore?: TrafficQuotaStore
  ) {}

  quotaStatus(source: TrafficRefreshSource = "background", now = new Date()) {
    return this.quotaStore?.getStatus?.(source, now);
  }

  async refreshCurrentRoute(input: TrafficRouteRefreshInput): Promise<TrafficRouteRefreshResult> {
    const options: RouteRequestOptions = {
      ...input.options,
      maxAlternatives: Math.min(input.options?.maxAlternatives ?? 2, 2),
      source: input.options?.source ?? "background"
    };
    const activeRoute = input.supportingPoints?.length
      ? await this.provider.evaluateStoredRoute(input.supportingPoints, input.destination, options)
      : await this.provider.calculateRoute(input.origin, input.destination, options);
    const quota = await this.quotaStore?.getStatus?.(options.source);

    return {
      activeRoute,
      alternatives: buildAlternativeProposals(activeRoute),
      quota
    };
  }
}

export class TomTomRoutingProvider implements RoutingProvider {
  private readonly apiKey?: string;
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly language: string;

  constructor(
    private readonly quotaStore: TrafficQuotaStore,
    private readonly fallback: RoutingProvider = new OsrmRoutingProvider(),
    private readonly fetchImpl: typeof fetch = fetch,
    config: TomTomRoutingConfig = {}
  ) {
    this.apiKey = config.apiKey ?? process.env.TOMTOM_API_KEY ?? process.env.TOMTOM_ROUTING_API_KEY;
    this.enabled = config.enabled !== false && (config.freeTierConfirmed ?? process.env.TOMTOM_FREE_TIER_CONFIRMED === "true");
    this.baseUrl = withTrailingSlash(config.baseUrl ?? process.env.TOMTOM_ROUTING_BASE_URL ?? "https://api.tomtom.com/");
    this.language = config.language ?? process.env.TOMTOM_ROUTING_LANGUAGE ?? "ru-RU";
  }

  geocode(address: string) {
    return this.fallback.geocode(address);
  }

  async calculateRoute(
    origin: Coordinate,
    destination: Coordinate,
    options: RouteRequestOptions = {}
  ): Promise<TrafficRouteResult> {
    if (!this.enabled || !this.apiKey) {
      return this.fallbackRoute(origin, destination, options, "not-configured");
    }

    try {
      await this.quotaStore.consume(options.source ?? "manual");
      const data = await this.fetchTomTomRoute([origin, destination], options);
      return this.mapRouteResponse(data, options);
    } catch (error) {
      if (error instanceof RoutingError && error.statusCode === 429) return this.fallbackRoute(origin, destination, options, "quota-exhausted");
      if (error instanceof RoutingError) return this.fallbackRoute(origin, destination, options, "fallback-no-traffic", error.message);
      return this.fallbackRoute(origin, destination, options, "fallback-no-traffic", "Сервис маршрутизации TomTom временно недоступен.");
    }
  }

  async calculateMultiStopRoute(stops: Coordinate[], options: RouteRequestOptions = {}): Promise<TrafficRouteResult> {
    if (stops.length < 2) {
      return emptyTrafficRoute(stops, this.enabled && this.apiKey ? "live-traffic" : "not-configured");
    }

    if (!this.enabled || !this.apiKey) {
      return this.fallbackMultiStop(stops, options, "not-configured");
    }

    try {
      await this.quotaStore.consume(options.source ?? "manual");
      const data = await this.fetchTomTomRoute(stops, options);
      return this.mapRouteResponse(data, options);
    } catch (error) {
      if (error instanceof RoutingError && error.statusCode === 429) return this.fallbackMultiStop(stops, options, "quota-exhausted");
      if (error instanceof RoutingError) return this.fallbackMultiStop(stops, options, "fallback-no-traffic", error.message);
      return this.fallbackMultiStop(stops, options, "fallback-no-traffic", "Сервис маршрутизации TomTom временно недоступен.");
    }
  }

  async evaluateStoredRoute(
    supportingPoints: Coordinate[],
    destination: Coordinate,
    options: RouteRequestOptions = {}
  ): Promise<TrafficRouteResult> {
    const origin = supportingPoints[0];
    if (!origin || supportingPoints.length < 2) throw new RoutingError("Для проверки сохранённого маршрута нужны минимум две опорные точки.", 400);
    return this.calculateRoute(origin, destination, { ...options, supportingPoints });
  }

  private async fetchTomTomRoute(stops: Coordinate[], options: RouteRequestOptions): Promise<TomTomRouteResponse> {
    const url = new URL(
      `routing/1/calculateRoute/${stops.map((stop) => `${stop.latitude},${stop.longitude}`).join(":")}/json`,
      this.baseUrl
    );
    url.searchParams.set("key", this.apiKey ?? "");
    url.searchParams.set("routeType", "fastest");
    url.searchParams.set("travelMode", "truck");
    url.searchParams.set("traffic", String(options.traffic ?? true));
    url.searchParams.set("computeTravelTimeFor", "all");
    url.searchParams.set("routeRepresentation", "polyline");
    url.searchParams.set("language", options.language ?? this.language);
    url.searchParams.append("sectionType", "traffic");
    url.searchParams.append("sectionType", "importantRoadStretch");
    url.searchParams.append("sectionType", "roadShields");

    if (options.maxAlternatives && options.maxAlternatives > 0) {
      url.searchParams.set("maxAlternatives", String(Math.min(options.maxAlternatives, 2)));
    }
    if (options.includeInstructions !== false) {
      url.searchParams.set("instructionsType", "text");
    }
    url.searchParams.set("departAt", options.departureTime && options.departureTime.getTime() > Date.now()
      ? options.departureTime.toISOString() : "now");
    applyTruckProfile(url, options.truck);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        ...(options.supportingPoints ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ supportingPoints: options.supportingPoints })
        } : {})
      });
      if (!response.ok) {
        throw new RoutingError(`Сервис маршрутизации TomTom вернул статус ${response.status}.`, response.status === 429 ? 429 : 502);
      }
      return (await response.json()) as TomTomRouteResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  private mapRouteResponse(data: TomTomRouteResponse, options: RouteRequestOptions): TrafficRouteResult {
    const routes = data.routes ?? [];
    const primary = routes[0];
    if (!primary) throw new RoutingError("TomTom не вернул маршрут.", 502);

    return toTrafficRouteResult(primary, "live-traffic", undefined, routes.slice(1, 3), options);
  }

  private async fallbackRoute(
    origin: Coordinate,
    destination: Coordinate,
    options: RouteRequestOptions,
    status: TrafficProviderStatus,
    warning?: string
  ): Promise<TrafficRouteResult> {
    const route = await this.fallback.calculateRoute(origin, destination, options);
    return fromFallbackRoute(route, status, warning);
  }

  private async fallbackMultiStop(
    stops: Coordinate[],
    options: RouteRequestOptions,
    status: TrafficProviderStatus,
    warning?: string
  ): Promise<TrafficRouteResult> {
    const route = await this.fallback.calculateMultiStopRoute(stops, options);
    return fromFallbackRoute(route, status, warning);
  }
}

type TomTomRouteResponse = {
  routes?: TomTomRoute[];
};

type TomTomRoute = {
  summary?: {
    lengthInMeters?: number;
    travelTimeInSeconds?: number;
    trafficDelayInSeconds?: number;
    noTrafficTravelTimeInSeconds?: number;
    historicTrafficTravelTimeInSeconds?: number;
    liveTrafficIncidentsTravelTimeInSeconds?: number;
  };
  legs?: Array<{
    points?: Array<{ latitude: number; longitude: number }>;
  }>;
  sections?: Array<{
    startPointIndex?: number;
    sectionType?: string;
    simpleCategory?: string;
    delayInSeconds?: number;
    magnitudeOfDelay?: number;
    roadNumbers?: string[];
    roadShieldReferences?: Array<{
      shieldContent?: string;
      roadNumber?: string;
      text?: string;
    }>;
  }>;
  guidance?: {
    instructions?: Array<{
      message?: string;
      roadNumbers?: string[];
      exitNumber?: string;
      street?: string;
      routeOffsetInMeters?: number;
      travelTimeInSeconds?: number;
    }>;
  };
};

function toTrafficRouteResult(
  route: TomTomRoute,
  providerStatus: TrafficProviderStatus,
  warning: string | undefined,
  alternatives: TomTomRoute[],
  options: RouteRequestOptions
): TrafficRouteResult {
  const summary = route.summary ?? {};
  const geometry = (route.legs ?? []).flatMap((leg) =>
    (leg.points ?? []).map((point) => ({ latitude: point.latitude, longitude: point.longitude }))
  );

  if (!Number.isFinite(summary.lengthInMeters) || (summary.lengthInMeters ?? -1) < 0
    || !Number.isFinite(summary.travelTimeInSeconds) || (summary.travelTimeInSeconds ?? -1) < 0
    || geometry.length < 2 || geometry.some((point) => !Number.isFinite(point.latitude)
      || !Number.isFinite(point.longitude) || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180)) {
    throw new RoutingError("TomTom вернул некорректный маршрут.", 502);
  }

  return {
    geometry,
    distanceMeters: Math.round(summary.lengthInMeters ?? 0),
    durationSeconds: Math.ceil(summary.travelTimeInSeconds ?? 0),
    provider: "tomtom",
    checkedAt: new Date().toISOString(),
    trafficDelaySeconds: Math.max(0, Math.ceil(summary.trafficDelayInSeconds ?? 0)),
    noTrafficDurationSeconds: numberOrUndefined(summary.noTrafficTravelTimeInSeconds),
    historicTrafficDurationSeconds: numberOrUndefined(summary.historicTrafficTravelTimeInSeconds),
    liveTrafficDurationSeconds: numberOrUndefined(summary.liveTrafficIncidentsTravelTimeInSeconds),
    roadNumbers: extractRoadNumbers(route),
    instructions: extractInstructions(route),
    alternatives: alternatives.map((alternative) => toTrafficRouteResult(alternative, providerStatus, warning, [], options)),
    hasRoadClosure: hasRoadClosure(route),
    providerStatus,
    warning
  };
}

function fromFallbackRoute(route: RouteResult, status: TrafficProviderStatus, warning?: string): TrafficRouteResult {
  return {
    ...route,
    checkedAt: new Date().toISOString(),
    trafficDelaySeconds: 0,
    roadNumbers: [],
    instructions: [],
    alternatives: [],
    hasRoadClosure: false,
    providerStatus: status,
    warning: `${warning ? `${warning} ` : ""}Без актуальных пробок и проверки ограничений для грузовиков.`
  };
}

function emptyTrafficRoute(stops: Coordinate[], status: TrafficProviderStatus): TrafficRouteResult {
  return {
    geometry: stops,
    distanceMeters: 0,
    durationSeconds: 0,
    provider: status === "live-traffic" ? "tomtom" : "osrm",
    checkedAt: new Date().toISOString(),
    trafficDelaySeconds: 0,
    roadNumbers: [],
    instructions: [],
    alternatives: [],
    hasRoadClosure: false,
    providerStatus: status,
    warning: status === "live-traffic" ? undefined : "Без актуальных пробок и проверки ограничений для грузовиков."
  };
}

function buildAlternativeProposals(activeRoute: TrafficRouteResult): RouteAlternativeProposal[] {
  return activeRoute.alternatives
    .filter((route) => !route.hasRoadClosure)
    .map((route) => ({
      route,
      reason: activeRoute.hasRoadClosure ? "road-closure" as const : "traffic-delay" as const,
      timeSavingSeconds: activeRoute.durationSeconds - route.durationSeconds,
      extraDistanceMeters: route.distanceMeters - activeRoute.distanceMeters,
      roadNumbers: route.roadNumbers
    }))
    .filter((proposal) => proposal.reason === "road-closure" || proposal.timeSavingSeconds >= 600)
    .slice(0, 2);
}

function quotaSettings(
  options: { namespace?: string; monthlyCap?: number; manualReserveRatio?: number },
  source: TrafficRefreshSource,
  now: Date
) {
  const configuredCap = options.monthlyCap ?? Number(process.env.TOMTOM_ROUTING_MONTHLY_CAP ?? 18_000);
  const monthlyCap = Number.isFinite(configuredCap) ? Math.max(0, Math.min(Math.floor(configuredCap), 18_000)) : 0;
  const manualReserveRatio = options.manualReserveRatio ?? Number(process.env.TOMTOM_MANUAL_RESERVE_RATIO ?? 0.2);
  const reservedForManual = Math.ceil(monthlyCap * (Number.isFinite(manualReserveRatio)
    ? Math.max(0.2, Math.min(1, manualReserveRatio)) : 1));
  const sourceLimit = source === "background" ? monthlyCap - reservedForManual : monthlyCap;
  return {
    id: `${options.namespace ?? "tomtom-routing"}:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
    monthlyCap,
    reservedForManual,
    sourceLimit
  };
}

function extractRoadNumbers(route: TomTomRoute): string[] {
  const numbers: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed && numbers.at(-1) !== trimmed) numbers.push(trimmed);
  };

  for (const section of [...(route.sections ?? [])].sort((a, b) => (a.startPointIndex ?? 0) - (b.startPointIndex ?? 0))) {
    for (const number of section.roadNumbers ?? []) add(number);
    for (const shield of section.roadShieldReferences ?? []) {
      add(shield.shieldContent);
      add(shield.roadNumber);
      add(shield.text);
    }
  }
  if (!numbers.length) {
    for (const instruction of route.guidance?.instructions ?? []) {
      for (const number of instruction.roadNumbers ?? []) add(number);
    }
  }
  return numbers;
}

function extractInstructions(route: TomTomRoute): RouteInstruction[] {
  return (route.guidance?.instructions ?? [])
    .filter((instruction) => typeof instruction.message === "string" && instruction.message.trim().length > 0)
    .map((instruction) => ({
      message: instruction.message?.trim() ?? "",
      roadNumber: instruction.roadNumbers?.[0],
      exitNumber: instruction.exitNumber,
      street: instruction.street,
      distanceMeters: numberOrUndefined(instruction.routeOffsetInMeters),
      travelTimeSeconds: numberOrUndefined(instruction.travelTimeInSeconds)
    }));
}

function hasRoadClosure(route: TomTomRoute): boolean {
  return (route.sections ?? []).some((section) =>
    section.simpleCategory === "ROAD_CLOSURE"
    || section.simpleCategory === "CLOSURE"
    || section.sectionType === "ROAD_CLOSURE"
  );
}

function applyTruckProfile(url: URL, truck?: TruckRouteProfile): void {
  if (!truck) return;
  setMeters(url, "vehicleHeight", truck.heightMeters);
  setMeters(url, "vehicleWidth", truck.widthMeters);
  setMeters(url, "vehicleLength", truck.lengthMeters);
  if (Number.isFinite(truck.weightKg)) url.searchParams.set("vehicleWeight", String(Math.round(truck.weightKg ?? 0)));
  if (Number.isFinite(truck.axleWeightKg)) url.searchParams.set("vehicleAxleWeight", String(Math.round(truck.axleWeightKg ?? 0)));
  if (Number.isFinite(truck.maxSpeedKmh)) url.searchParams.set("vehicleMaxSpeed", String(Math.round(truck.maxSpeedKmh ?? 0)));
}

function setMeters(url: URL, key: string, value: number | undefined): void {
  if (Number.isFinite(value)) url.searchParams.set(key, String(value));
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
