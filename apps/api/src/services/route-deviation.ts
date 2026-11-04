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

/** Watches trucks with fresh Webfleet GPS and tells the dispatcher once per detour. Read-only towards Webfleet. */
export class RouteDeviationService {
  private readonly tracking = new Map<string, Tracking>();
  private lastRunAt = 0;

  constructor(
    private readonly db: Pick<PrismaClient, "vehicle">,
    private readonly getPosition: (vehicleId: string, now: Date) => Promise<CurrentPosition>,
    private readonly publish: Publish
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
      await this.publish({
        dedupKey: `deviation:${position.legId}:${position.telemetryRecordedAt}`, vehicleId: vehicle.id, type: "ROUTE_DEVIATION",
        message: `LKW ${vehicle.vehicleNumber} отклонилась от маршрута: ≈ ${Math.round(off / 100) / 10} км от проложенной линии по GPS Webfleet. Посмотрите варианты маршрута.`,
        payload: { legId: position.legId, offRouteMeters: Math.round(off), recordedAt: position.telemetryRecordedAt }
      });
    }
    this.tracking.set(vehicle.id, next);
  }
}
