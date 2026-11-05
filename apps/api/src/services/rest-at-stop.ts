import type { PrismaClient } from "@prisma/client";
import type { WebfleetDrivingTimes, WebfleetLiveStore } from "./webfleet-live.js";

/** Tachograph work states (driver_currentworkstate) that are rest: 1 free time, 2 break. */
const REST_STATES = new Set([1, 2]);
/** 3 = availability (Bereitschaft): the driver waits at the dock. */
const WAITING_STATES = new Set([3]);
/** 4 = work, 6 = other work: loading, unloading, paperwork. */
const WORKING_STATES = new Set([4, 6]);
/** Driving times older than this do not say what the driver does now. */
const TIMES_FRESH_MS = 30 * 60_000;
const DAILY_REST_MS = 9 * 3600_000;
const CHECK_INTERVAL_MS = 60_000;

export type DailyRest = { since: string | null; until: string | null };
export type RestAtStop = DailyRest & { stopId: string; stopType: "LOAD" | "UNLOAD"; place: string };
/**
 * What the driver does while the truck stands at a stop, from the tachograph:
 * DAILY_REST only when the day is used up; BREAK while driving time is still left; WAITING / WORKING at the dock.
 */
export type StopActivityKind = "DAILY_REST" | "BREAK" | "WAITING" | "WORKING";
export type StopActivity = DailyRest & {
  kind: StopActivityKind;
  /** Driving time left today by the tachograph; null when Webfleet does not say. */
  drivingLeftMs: number | null;
  /** Latest end of the current shift (Webfleet); null when unknown. */
  shiftEndAt: string | null;
};
export type ActivityAtStop = StopActivity & { stopId: string; stopType: "LOAD" | "UNLOAD"; place: string };

type ActivityInput = { workState: number | null | undefined; activitySince?: string | null; times: WebfleetDrivingTimes | null; now: Date };

/**
 * Reads the driver's state from the real tachograph in Webfleet. A long stop is not a daily rest by itself:
 * as long as the driver still has driving time and shift left, resting is a break. It becomes the daily rest only when
 * no driving time is left today, the shift has ended, or the daily rest is due now. Without fresh data nothing is guessed.
 */
export function stopActivityOf(input: ActivityInput): StopActivity | null {
  const { workState, times, now } = input;
  if (workState == null || !times?.referenceTime) return null;
  if (now.getTime() - Date.parse(times.referenceTime) > TIMES_FRESH_MS) return null;
  const since = input.activitySince ?? null;
  const base = { since, drivingLeftMs: times.remainDrivingTodayMs, shiftEndAt: times.latestShiftEndAt };
  if (WAITING_STATES.has(workState)) return { ...base, kind: "WAITING", until: null };
  if (WORKING_STATES.has(workState)) return { ...base, kind: "WORKING", until: null };
  if (!REST_STATES.has(workState)) return null;
  const past = (iso: string | null) => iso !== null && Date.parse(iso) <= now.getTime();
  const noDrivingLeft = times.remainDrivingTodayMs !== null && times.remainDrivingTodayMs <= 60_000;
  if (noDrivingLeft || past(times.nextRestAt) || past(times.latestShiftEndAt)) {
    const nextShift = times.earliestNextShiftAt && Date.parse(times.earliestNextShiftAt) > now.getTime() ? times.earliestNextShiftAt : null;
    return { ...base, kind: "DAILY_REST", until: nextShift ?? (since ? new Date(Date.parse(since) + DAILY_REST_MS).toISOString() : null) };
  }
  // A break: it counts on the tachograph once its minimum length (45 or 30 min) is reached.
  const breakEnd = since && times.nextBreakMinMs ? new Date(Date.parse(since) + times.nextBreakMinMs).toISOString() : null;
  return { ...base, kind: "BREAK", until: breakEnd };
}

/** Daily rest only; a break or waiting at the dock is not one. */
export function dailyRestOf(input: ActivityInput): DailyRest | null {
  const activity = stopActivityOf(input);
  return activity?.kind === "DAILY_REST" ? { since: activity.since, until: activity.until } : null;
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
  private activities = new Map<string, ActivityAtStop>();
  private lastRunAt = 0;

  constructor(private readonly db: Db, private readonly store: WebfleetLiveStore, private readonly publish: Publish) {}

  /** The last known daily rest of a truck at its stop; empty for a break, waiting, work or without fresh tachograph data. */
  restAt(vehicleId: string) { return this.current.get(vehicleId) ?? null; }
  /** What the driver does at the stop right now: daily rest, break, waiting or work; empty without fresh tachograph data. */
  activityAt(vehicleId: string) { return this.activities.get(vehicleId) ?? null; }

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
    const activities = new Map<string, ActivityAtStop>();
    for (const vehicle of vehicles) {
      const stop = vehicle.tours[0]?.stops.find((item) => !item.completedAt);
      const objectUid = objectOf.get(vehicle.id);
      if (!stop?.arrivedAt || !objectUid || (stop.type !== "LOAD" && stop.type !== "UNLOAD")) continue;
      const driver = this.store.driverOn(objectUid, now);
      if (!driver?.driverUid) continue;
      const tacho = this.store.activity(driver.driverUid);
      const activity = stopActivityOf({ workState: driver.workState, activitySince: tacho && tacho.workState === driver.workState ? tacho.since : null,
        times: this.store.drivingTimes(driver.driverUid), now });
      if (!activity) continue;
      const place = stop.city || stop.company || stop.address;
      activities.set(vehicle.id, { ...activity, stopId: stop.id, stopType: stop.type, place });
      if (activity.kind !== "DAILY_REST") continue;
      const rest: DailyRest = { since: activity.since, until: activity.until };
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
    this.activities = activities;
  }
}
