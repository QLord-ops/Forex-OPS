export type Coordinate = {
  latitude: number;
  longitude: number;
};

export type RouteGeometry = Coordinate[];

export type RouteResult = {
  geometry: RouteGeometry;
  distanceMeters: number;
  durationSeconds: number;
  provider: string;
};

export type GeocodeResult = Coordinate & {
  city?: string | null;
  label: string;
  provider: string;
};

export type RiskColor = "GREEN" | "YELLOW" | "ORANGE" | "RED" | "GREY";

export type JsonObject = Record<string, unknown>;

export type StructuredCity = {
  name: string;
  countryCode?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
};

export type ServiceDurationWindow = {
  minMinutes: number;
  maxMinutes: number;
};

export type StopPlanningContract = {
  city?: string | StructuredCity | null;
  appointmentAt?: string | Date | null;
  serviceMinMinutes?: number | null;
  serviceMaxMinutes?: number | null;
};

export type TruckProfile = {
  maxSpeedKmh: number;
  breakAfterDriveMinutes?: number;
  breakDurationMinutes?: number;
  dailyDriveLimitMinutes?: number;
};

export type VehicleClockPhase =
  | "IDLE"
  | "DRIVING"
  | "RESTING"
  | "BREAK"
  | "SERVICE"
  | "MANUAL_STOPPED";

export type VehicleClockState = {
  phase: VehicleClockPhase;
  asOf: string;
  accumulatedDriveSeconds: number;
  operationVersion: number;
  manualStoppedAt?: string | null;
  restUntil?: string | null;
};

export type DrivePlanSegmentKind = "DRIVE" | "BREAK" | "REST" | "SERVICE" | "MANUAL_STOP";

export type DrivePlanSegment = {
  kind: DrivePlanSegmentKind;
  startOffsetSeconds: number;
  durationSeconds: number;
  label?: string;
};

export type LegDrivePlan = {
  version: number;
  totalDriveSeconds: number;
  totalElapsedSeconds: number;
  segments: DrivePlanSegment[];
};

export type ClockAwareLegProgress = {
  driveElapsedSeconds: number;
  wallElapsedSeconds: number;
  paused: boolean;
  pauseKind?: DrivePlanSegmentKind;
};

export type CurrentPosition = {
  state:
    | "NO_ACTIVE_ROUTE"
    | "WAITING_FOR_START"
    | "DWELL"
    | "UNTERWEGS"
    | "ANGEKOMMEN_WARTET_AUF_BESTAETIGUNG"
    | "COMPLETED";
  status: "IDLE" | "WAITING" | "MOVING" | "ARRIVED";
  disclaimer: string;
  positionSource?: "WEBFLEET" | "CALCULATED";
  telemetryRecordedAt?: string | null;
  telemetryAgeSeconds?: number | null;
  telemetryStale?: boolean;
  position: Coordinate | null;
  coordinate: [number, number] | null;
  tourId: string | null;
  legId: string | null;
  geometryVersion: string | null;
  startedAt: string | null;
  delayMinutes: number;
  routeGeometry: Array<[number, number]>;
  travelledGeometry: Array<[number, number]>;
  remainingGeometry: Array<[number, number]>;
  progress: number;
  distanceTravelledMeters: number;
  remainingDistanceMeters: number;
  eta: string | null;
};

export const CALCULATED_POSITION_DISCLAIMER =
  "Berechnete Position – keine GPS-Daten" as const;

export function withoutPositionGeometry(position: CurrentPosition) {
  const { routeGeometry: _route, travelledGeometry: _travelled, remainingGeometry: _remaining, ...summary } = position;
  return summary;
}

export function normalizeServiceWindow(
  minMinutes: unknown,
  maxMinutes: unknown,
  fallback: ServiceDurationWindow = { minMinutes: 60, maxMinutes: 120 }
): ServiceDurationWindow {
  const min = typeof minMinutes === "number" && Number.isFinite(minMinutes) ? minMinutes : fallback.minMinutes;
  const max = typeof maxMinutes === "number" && Number.isFinite(maxMinutes) ? maxMinutes : fallback.maxMinutes;
  return {
    minMinutes: Math.max(0, Math.min(min, max)),
    maxMinutes: Math.max(0, Math.max(min, max))
  };
}

export function toNullableDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function readOptionalNumber(source: unknown, key: string): number | null {
  if (!isJsonObject(source)) return null;
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readOptionalString(source: unknown, key: string): string | null {
  if (!isJsonObject(source)) return null;
  const value = source[key];
  return typeof value === "string" ? value : null;
}

export function readQueueIndex(source: unknown): number | null {
  return readOptionalNumber(source, "queueIndex");
}

export function compareQueuedItems(a: unknown, b: unknown): number {
  const aQueue = readQueueIndex(a);
  const bQueue = readQueueIndex(b);
  if (aQueue !== null || bQueue !== null) return (aQueue ?? Number.MAX_SAFE_INTEGER) - (bQueue ?? Number.MAX_SAFE_INTEGER);

  const aPlan = toNullableDate(isJsonObject(a) ? a.plannedStartAt : null)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bPlan = toNullableDate(isJsonObject(b) ? b.plannedStartAt : null)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (aPlan !== bPlan) return aPlan - bPlan;

  const aCreated = toNullableDate(isJsonObject(a) ? a.createdAt : null)?.getTime() ?? 0;
  const bCreated = toNullableDate(isJsonObject(b) ? b.createdAt : null)?.getTime() ?? 0;
  if (aCreated !== bCreated) return aCreated - bCreated;

  return String(isJsonObject(a) ? a.id ?? "" : "").localeCompare(String(isJsonObject(b) ? b.id ?? "" : ""));
}

export function readVehicleClockState(source: unknown): VehicleClockState | null {
  const raw = isJsonObject(source) ? source.clockState : null;
  const value = parseJsonObject(raw);
  if (!value) return null;

  const phase = readClockPhase(value.phase);
  const asOf = toNullableDate(value.asOf)?.toISOString();
  const accumulatedDriveSeconds = readOptionalNumber(value, "accumulatedDriveSeconds") ?? 0;
  const operationVersion = readOptionalNumber(value, "operationVersion") ?? 0;
  if (!asOf) return null;

  return {
    phase,
    asOf,
    accumulatedDriveSeconds,
    operationVersion,
    manualStoppedAt: toNullableDate(value.manualStoppedAt)?.toISOString() ?? null,
    restUntil: toNullableDate(value.restUntil)?.toISOString() ?? null
  };
}

export function readLegDrivePlan(source: unknown): LegDrivePlan | null {
  const raw = isJsonObject(source) ? source.drivePlan : null;
  const value = parseJsonObject(raw);
  if (!value || !Array.isArray(value.segments)) return null;

  const segments = value.segments.flatMap((segment): DrivePlanSegment[] => {
    if (!isJsonObject(segment)) return [];
    const kind = readDrivePlanSegmentKind(segment.kind);
    const startOffsetSeconds = readOptionalNumber(segment, "startOffsetSeconds");
    const durationSeconds = readOptionalNumber(segment, "durationSeconds");
    if (startOffsetSeconds === null || durationSeconds === null) return [];
    return [{
      kind,
      startOffsetSeconds: Math.max(0, startOffsetSeconds),
      durationSeconds: Math.max(0, durationSeconds),
      label: readOptionalString(segment, "label") ?? undefined
    }];
  });

  const totalDriveSeconds =
    readOptionalNumber(value, "totalDriveSeconds") ??
    segments.filter((segment) => segment.kind === "DRIVE").reduce((sum, segment) => sum + segment.durationSeconds, 0);
  const totalElapsedSeconds =
    readOptionalNumber(value, "totalElapsedSeconds") ??
    segments.reduce((max, segment) => Math.max(max, segment.startOffsetSeconds + segment.durationSeconds), 0);

  return {
    version: readOptionalNumber(value, "version") ?? 0,
    totalDriveSeconds,
    totalElapsedSeconds,
    segments: segments.sort((a, b) => a.startOffsetSeconds - b.startOffsetSeconds)
  };
}

export function buildSimpleDrivePlan(simulatedDurationSeconds: number): LegDrivePlan {
  const durationSeconds = Math.max(0, Math.ceil(simulatedDurationSeconds));
  return {
    version: 0,
    totalDriveSeconds: durationSeconds,
    totalElapsedSeconds: durationSeconds,
    segments: durationSeconds > 0
      ? [{ kind: "DRIVE", startOffsetSeconds: 0, durationSeconds }]
      : []
  };
}

export function calculateClockAwareLegProgress(input: {
  startedAt: Date | null | undefined;
  now: Date;
  manualStoppedAt?: Date | null;
  drivePlan?: LegDrivePlan | null;
}): ClockAwareLegProgress {
  if (!input.startedAt) {
    return { driveElapsedSeconds: 0, wallElapsedSeconds: 0, paused: false };
  }

  const effectiveNow = input.manualStoppedAt && input.manualStoppedAt < input.now ? input.manualStoppedAt : input.now;
  const wallElapsedSeconds = Math.max(0, (effectiveNow.getTime() - input.startedAt.getTime()) / 1000);
  const plan = input.drivePlan;

  if (!plan || plan.segments.length === 0) {
    return {
      driveElapsedSeconds: wallElapsedSeconds,
      wallElapsedSeconds,
      paused: Boolean(input.manualStoppedAt && input.manualStoppedAt <= input.now),
      pauseKind: input.manualStoppedAt && input.manualStoppedAt <= input.now ? "MANUAL_STOP" : undefined
    };
  }

  let driveElapsedSeconds = 0;
  let pauseKind: DrivePlanSegmentKind | undefined;
  for (const segment of plan.segments) {
    if (wallElapsedSeconds < segment.startOffsetSeconds) break;
    const elapsedWithinSegment = Math.min(segment.durationSeconds, wallElapsedSeconds - segment.startOffsetSeconds);
    if (segment.kind === "DRIVE") {
      driveElapsedSeconds += Math.max(0, elapsedWithinSegment);
    } else if (wallElapsedSeconds < segment.startOffsetSeconds + segment.durationSeconds) {
      pauseKind = segment.kind;
    }
  }

  if (input.manualStoppedAt && input.manualStoppedAt <= input.now) {
    pauseKind = "MANUAL_STOP";
  }

  return {
    driveElapsedSeconds: Math.min(plan.totalDriveSeconds, driveElapsedSeconds),
    wallElapsedSeconds,
    paused: Boolean(pauseKind),
    pauseKind
  };
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function parseJsonObject(raw: unknown): JsonObject | null {
  if (isJsonObject(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readClockPhase(value: unknown): VehicleClockPhase {
  return value === "DRIVING" ||
    value === "RESTING" ||
    value === "BREAK" ||
    value === "SERVICE" ||
    value === "MANUAL_STOPPED"
    ? value
    : "IDLE";
}

function readDrivePlanSegmentKind(value: unknown): DrivePlanSegmentKind {
  return value === "BREAK" || value === "REST" || value === "SERVICE" || value === "MANUAL_STOP" ? value : "DRIVE";
}
