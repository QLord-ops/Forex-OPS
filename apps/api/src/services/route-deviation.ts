import type { PrismaClient } from "@prisma/client";
import type { CurrentPosition } from "../domain.js";
import { OFF_ROUTE_METERS } from "./route-projection.js";

/** Two GPS points in a row beyond 2 km from the planned line: a real detour, not a petrol station or a junction. */
export const DEVIATION_POINTS = 2;
// Back within 1 km of the line ends the detour, so a later one is reported again.
const BACK_ON_ROUTE_METERS = 1_000;
const CHECK_INTERVAL_MS = 60_000;

type Publish = (input: { dedupKey: string; vehicleId: string; stopId?: string; type: string; message: string; payload: unknown }) => Promise<unknown>;
type Tracking = { recordedAt: string; offCount: number; reported: boolean };
type Rebuilt = { distanceMeters: number; eta: string | null; previousEta: string | null; mainRoads: string[]; live: boolean };
type Reroute = (vehicleId: string, now: Date) => Promise<Rebuilt | null>;

const BERLIN_DAY = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit" });
const BERLIN_TIME = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });

/** "14:20" today, "12.11. 06:40" on another day. */
function clock(iso: string, now: Date): string {
  const at = new Date(iso);
  const day = BERLIN_DAY.format(at);
  return day === BERLIN_DAY.format(now) ? BERLIN_TIME.format(at) : `${day} ${BERLIN_TIME.format(at)}`;
}

export function rebuiltMessage(vehicleNumber: string, rebuilt: Rebuilt, now: Date): string {
  const via = rebuilt.mainRoads.length ? ` через ${rebuilt.mainRoads.join(", ")}` : "";
  const was = rebuilt.previousEta && rebuilt.eta && clock(rebuilt.previousEta, now) !== clock(rebuilt.eta, now) ? ` (было ${clock(rebuilt.previousEta, now)})` : "";
  const eta = rebuilt.eta ? ` ETA ${clock(rebuilt.eta, now)}${was}.` : "";
  return `LKW ${vehicleNumber} поехал по другому маршруту. Новый маршрут построен от позиции GPS: ${Math.round(rebuilt.distanceMeters / 1000)} км${via}.${eta}${rebuilt.live ? "" : " Без данных о пробках."}`;
}

/**
 * Watches trucks with fresh Webfleet GPS. On a detour the route is rebuilt from the truck and the dispatcher is only
 * told; when it cannot be rebuilt they are asked to look at the routes. Read-only towards Webfleet.
 */
export class RouteDeviationService {
  private readonly tracking = new Map<string, Tracking>();
  private lastRunAt = 0;

  constructor(
    private readonly db: Pick<PrismaClient, "vehicle">,
    private readonly getPosition: (vehicleId: string, now: Date) => Promise<CurrentPosition>,
    private readonly publish: Publish,
    private readonly reroute?: Reroute
  ) {}

  async check(now = new Date(), force = false) {
    if (!force && now.getTime() - this.lastRunAt < CHECK_INTERVAL_MS) return;
    this.lastRunAt = now.getTime();
    const vehicles = await this.db.vehicle.findMany({ where: { tours: { some: { status: "ACTIVE" } } }, select: { id: true, vehicleNumber: true } });
    for (const vehicle of vehicles) {
      try { await this.checkVehicle(vehicle, now); } catch { /* One truck must not stop the others. */ }
    }
  }

  private async checkVehicle(vehicle: { id: string; vehicleNumber: string }, now: Date) {
    const position = await this.getPosition(vehicle.id, now);
    if (position.etaSource !== "GPS" || position.offRouteMeters == null || !position.telemetryRecordedAt || !position.legId) {
      this.tracking.delete(vehicle.id);
      return;
    }
    const previous = this.tracking.get(vehicle.id) ?? { recordedAt: "", offCount: 0, reported: false };
    // Count each GPS point once: the check runs more often than Webfleet reports.
    if (previous.recordedAt === position.telemetryRecordedAt) return;
    const off = position.offRouteMeters;
    const next: Tracking = off > OFF_ROUTE_METERS
      ? { recordedAt: position.telemetryRecordedAt, offCount: previous.offCount + 1, reported: previous.reported }
      : off < BACK_ON_ROUTE_METERS ? { recordedAt: position.telemetryRecordedAt, offCount: 0, reported: false }
        : { ...previous, recordedAt: position.telemetryRecordedAt };
    if (next.offCount >= DEVIATION_POINTS && !next.reported) {
      next.reported = true;
      // A failed rebuild never hides the detour: the dispatcher is then asked, as before.
      const rebuilt = this.reroute ? await this.reroute(vehicle.id, now).catch(() => null) : null;
      const payload = { legId: position.legId, offRouteMeters: Math.round(off), recordedAt: position.telemetryRecordedAt };
      await this.publish({
        dedupKey: `deviation:${position.legId}:${position.telemetryRecordedAt}`, vehicleId: vehicle.id, type: "ROUTE_DEVIATION",
        message: rebuilt ? rebuiltMessage(vehicle.vehicleNumber, rebuilt, now)
          : `LKW ${vehicle.vehicleNumber} отклонилась от маршрута: ≈ ${Math.round(off / 100) / 10} км от проложенной линии по GPS Webfleet. Посмотрите варианты маршрута.`,
        payload: rebuilt ? { ...payload, rebuilt: true, ...rebuilt } : payload
      });
      // The truck is on its new line: the next detour is a new one.
      if (rebuilt) { next.offCount = 0; next.reported = false; }
    }
    this.tracking.set(vehicle.id, next);
  }
}
