import type { PrismaClient } from "@prisma/client";
import type { WebfleetDrivingTimes, WebfleetLiveStore } from "./webfleet-live.js";

/** Tachograph work states (driver_currentworkstate) that are rest: 1 free time, 2 break. */
const REST_STATES = new Set([1, 2]);
/** Driving times older than this do not say what the driver does now. */
const TIMES_FRESH_MS = 30 * 60_000;
const DAILY_REST_MS = 9 * 3600_000;
const LONG_REST_MS = 3 * 3600_000;
const CHECK_INTERVAL_MS = 60_000;

export type DailyRest = { since: string | null; until: string | null };
export type RestAtStop = DailyRest & { stopId: string; stopType: "LOAD" | "UNLOAD"; place: string };

/**
 * Daily rest, only from the real tachograph in Webfleet: the driver is resting and the day is used up
 * (no driving time left, or the daily rest is due now). A 45-minute break with driving time left is not daily rest.
 */
export function dailyRestOf(input: { workState: number | null | undefined; activitySince?: string | null; times: WebfleetDrivingTimes | null; now: Date }): DailyRest | null {
  const { workState, times, now } = input;
  if (workState == null || !REST_STATES.has(workState) || !times?.referenceTime) return null;
  if (now.getTime() - Date.parse(times.referenceTime) > TIMES_FRESH_MS) return null;
  const since = input.activitySince ?? null;
  const past = (iso: string | null) => iso !== null && Date.parse(iso) <= now.getTime();
  const noDrivingLeft = times.remainDrivingTodayMs !== null && times.remainDrivingTodayMs <= 60_000;
  // Longer than any break: the first part of a split daily rest is 3 h.
  const longRest = since !== null && now.getTime() - Date.parse(since) >= LONG_REST_MS;
  if (!noDrivingLeft && !past(times.nextRestAt) && !past(times.latestShiftEndAt) && !longRest) return null;
  const nextShift = times.earliestNextShiftAt && Date.parse(times.earliestNextShiftAt) > now.getTime() ? times.earliestNextShiftAt : null;
  const until = nextShift ?? (since ? new Date(Date.parse(since) + DAILY_REST_MS).toISOString() : null);
  return { since, until };
}

type Db = Pick<PrismaClient, "vehicle" | "vehicleIntegration">;
type Publish = (input: { dedupKey: string; vehicleId: string; stopId?: string; type: string; message: string; payload: unknown }) => Promise<unknown>;

const BERLIN_TIME = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
const BERLIN_DAY_TIME = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const clock = (iso: string, now: Date) => {
  const at = new Date(iso);
  const sameDay = at.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }) === now.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
  return (sameDay ? BERLIN_TIME : BERLIN_DAY_TIME).format(at).replace(",", "");
};

/**
 * A truck at a loading or unloading point whose driver went into daily rest: the dispatcher is told once per stop and rest,
 * and the dashboard marks that the loading or unloading goes on after the rest. Reads only server memory, no Webfleet call.
 */
export class RestAtStopService {
  private current = new Map<string, RestAtStop>();
  private lastRunAt = 0;

  constructor(private readonly db: Db, private readonly store: WebfleetLiveStore, private readonly publish: Publish) {}

  /** The last known rest of a truck at its stop; empty when the driver works or no fresh tachograph data is in memory. */
  restAt(vehicleId: string) { return this.current.get(vehicleId) ?? null; }

  async check(now = new Date(), force = false) {
    if (!force && now.getTime() - this.lastRunAt < CHECK_INTERVAL_MS) return;
    this.lastRunAt = now.getTime();
    const [vehicles, bindings] = await Promise.all([
      this.db.vehicle.findMany({
        where: { tours: { some: { status: "ACTIVE" } } },
        select: { id: true, vehicleNumber: true, tours: { where: { status: "ACTIVE" }, select: { stops: { orderBy: { sequence: "asc" } } } } }
      }),
      this.db.vehicleIntegration.findMany({ where: { provider: "WEBFLEET", status: "ACTIVE" }, select: { vehicleId: true, externalId: true } })
    ]);
    const objectOf = new Map(bindings.map((binding) => [binding.vehicleId, binding.externalId]));
    const next = new Map<string, RestAtStop>();
    for (const vehicle of vehicles) {
      const stop = vehicle.tours[0]?.stops.find((item) => !item.completedAt);
      const objectUid = objectOf.get(vehicle.id);
      if (!stop?.arrivedAt || !objectUid || (stop.type !== "LOAD" && stop.type !== "UNLOAD")) continue;
      const driver = this.store.driverOn(objectUid, now);
      if (!driver?.driverUid) continue;
      const activity = this.store.activity(driver.driverUid);
      const rest = dailyRestOf({ workState: driver.workState, activitySince: activity && activity.workState === driver.workState ? activity.since : null,
        times: this.store.drivingTimes(driver.driverUid), now });
      if (!rest) continue;
      const place = stop.city || stop.company || stop.address;
      const item: RestAtStop = { ...rest, stopId: stop.id, stopType: stop.type, place };
      next.set(vehicle.id, item);
      if (this.current.get(vehicle.id)?.stopId === stop.id) continue;
      const work = stop.type === "LOAD" ? "Загрузка" : "Выгрузка";
      await this.publish({
        // One notice per stop and rest: a second rest at the same stop (two nights) is reported again.
        dedupKey: `daily-rest:${stop.id}:${rest.since ?? now.toISOString().slice(0, 10)}`,
        vehicleId: vehicle.id, stopId: stop.id, type: "DAILY_REST_AT_STOP",
        message: `LKW ${vehicle.vehicleNumber} на ${stop.type === "LOAD" ? "загрузке" : "выгрузке"} в ${place}: водитель на суточном отдыхе`
          + `${rest.since ? ` с ${clock(rest.since, now)}` : ""} (тахограф Webfleet). ${work} продолжится после отдыха${rest.until ? `, не раньше ${clock(rest.until, now)}` : ""}.`,
        payload: { stopType: stop.type, place, since: rest.since, until: rest.until, source: "WEBFLEET_TACHOGRAPH" }
      });
    }
    this.current = next;
  }
}
