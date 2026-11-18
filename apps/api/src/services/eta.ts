import type { Prisma } from "@prisma/client";
import { compareQueuedItems, normalizeServiceWindow, type RiskColor } from "../domain.js";
import { calculateLateMinutes, calculateRiskColor } from "./simulation.js";
import { applyStopTime, forecastDrive, type ClockState } from "./vehicle-clock.js";
import { breakdownTiming, forecastClock, parseClockState, readPersistedDrivePlan, snapshotVehicleClock, waitClockUntil, type VehicleIssueTiming } from "./tours.js";
import { forecastEta, WebfleetEngine, type DriveEngine, type DriverEtaInput } from "./termin-planner.js";

type TourStatus = "DRAFT" | "QUEUED" | "ACTIVE" | "COMPLETED" | "CANCELLED";
type TourWithStopsAndLegs = Prisma.TourGetPayload<{ include: { stops: true; legs: true } }> & {
  vehicle?: { clockState?: string | null; manualStoppedAt?: Date | null; issues?: VehicleIssueTiming[] };
};

export type ScheduleStop = {
  tourId: string; stopId: string; sequence: number; type: string; address: string;
  city: string | null; appointmentAt: Date | null;
  appointmentWindowStartAt: Date | null; appointmentWindowEndAt: Date | null; deadlineAt: Date | null;
  earliestArrival: Date | null; latestArrival: Date | null; earliestDeparture: Date | null; latestDeparture: Date | null;
  predictedEta: Date | null; predictedDelayMinutes: number; definiteDelayMinutes: number;
  riskColor: RiskColor; tourStatus: TourStatus; preliminary: boolean;
};

/** The arrival at one stop is already known from elsewhere (the ETA measured from GPS): the stops after it are planned from it. */
export type ScheduleAnchor = { stopId: string; arrival: Date };

/**
 * What the main screen says about an open stop: one time in the middle of the earliest and the latest arrival, because
 * loading and unloading before it take one to two hours each (owner, 18.11). PLAN: the tour has not begun and nothing says
 * where the truck is, so the times assume it reaches the first stop at its Termin.
 */
export type StopEta = { eta: string | null; earliest: string | null; latest: string | null; basis: "ETA" | "PLAN" };

export class EtaService {
  /** The next stops of one truck in order; with the driver's tachograph the drives are planned on the real hours. */
  calculateVehicleSchedule(tours: TourWithStopsAndLegs[], now = new Date(), driver: DriverEtaInput | null = null, anchor: ScheduleAnchor | null = null): ScheduleStop[] {
    const relevant = tours.filter((tour) => ["ACTIVE", "QUEUED"].includes(tour.status))
      .sort((a, b) => Number(a.status === "QUEUED") - Number(b.status === "QUEUED") || compareQueuedItems(a, b));
    const vehicle = relevant[0]?.vehicle;
    if (driver && !breakdownTiming(vehicle ?? {}, now).blocked) return this.scheduleByTachograph(relevant, now, driver, anchor);
    return this.scheduleByClock(relevant, now, anchor);
  }

  /**
   * The ETA of every open stop of the active tour. `shownEta` is the ETA the page shows for the stop the truck drives to
   * (from GPS when it is fresh): the following stops continue from it, with the stay at each stop and the driver's breaks.
   */
  stopEtas(tours: TourWithStopsAndLegs[], tourId: string, now = new Date(), driver: DriverEtaInput | null = null, shownEta: Date | null = null): Map<string, StopEta> {
    const result = new Map<string, StopEta>();
    const current = tours.find((tour) => tour.id === tourId)?.stops.filter((stop) => !stop.completedAt).sort((a, b) => a.sequence - b.sequence)[0];
    if (!current) return result;
    let schedule = this.calculateVehicleSchedule(tours, now, driver, !current.arrivedAt && shownEta ? { stopId: current.id, arrival: shownEta } : null);
    let basis: StopEta["basis"] = "ETA";
    if (!current.arrivedAt && !schedule.find((item) => item.stopId === current.id)?.earliestArrival) {
      const start = current.appointmentAt ?? current.appointmentWindowStartAt ?? current.plannedAt;
      if (start && start > now) {
        schedule = this.calculateVehicleSchedule(tours, now, driver, { stopId: current.id, arrival: start });
        basis = "PLAN";
      }
    }
    for (const item of schedule) {
      if (item.tourId !== tourId) continue;
      // The Termin of the first stop is the assumption, not a forecast of the arrival there.
      const early = basis === "PLAN" && item.stopId === current.id ? null : item.earliestArrival;
      const late = basis === "PLAN" && item.stopId === current.id ? null : item.latestArrival;
      const middle = early && late ? new Date((early.getTime() + late.getTime()) / 2) : early ?? late;
      result.set(item.stopId, { eta: middle?.toISOString() ?? null, earliest: early?.toISOString() ?? null, latest: late?.toISOString() ?? null, basis });
    }
    return result;
  }

  private scheduleByTachograph(relevant: TourWithStopsAndLegs[], now: Date, driver: DriverEtaInput, anchor: ScheduleAnchor | null): ScheduleStop[] {
    const vehicle = relevant[0]?.vehicle;
    const from = driver.startsAt && driver.startsAt > now ? driver.startsAt : now;
    let early: Date | null = from;
    let late: Date | null = from;
    let earlyEngine: DriveEngine = new WebfleetEngine(driver.budget);
    let lateEngine: DriveEngine = earlyEngine.clone();
    const result: ScheduleStop[] = [];
    for (const tour of relevant) {
      for (const stop of [...tour.stops].sort((a, b) => a.sequence - b.sequence)) {
        if (stop.completedAt) continue;
        const leg = tour.legs.find((item) => item.toStopId === stop.id && item.status !== "COMPLETED");
        const deadlineAt = stop.appointmentAt ?? stop.appointmentWindowEndAt;
        const drive = (seconds: number) => {
          if (early === null || late === null) return;
          const a = forecastEta(earlyEngine, seconds, early, deadlineAt);
          const b = forecastEta(lateEngine, seconds, late, deadlineAt);
          early = a.endAt; late = b.endAt; earlyEngine = a.engine; lateEngine = b.engine;
        };
        if (stop.arrivedAt) {
          early = late = stop.arrivedAt;
        } else if (leg?.startedAt && ["ACTIVE", "ARRIVED"].includes(leg.status)) {
          const snapshot = snapshotVehicleClock(vehicle ?? {}, leg, now);
          drive(Math.max(0, leg.simulatedDurationSeconds - snapshot.driveElapsedSeconds));
        } else if (leg) {
          drive(leg.simulatedDurationSeconds);
        } else if (tour.approachDurationSeconds != null && result.length === 0 && stop.sequence === 1) {
          drive(tour.approachDurationSeconds);
        } else {
          early = null;
          late = null;
        }
        if (anchor?.stopId === stop.id && !stop.arrivedAt) early = late = anchor.arrival;
        const window = normalizeServiceWindow(stop.serviceMinMinutes, stop.serviceMaxMinutes);
        const serviceStart = stop.appointmentAt ?? stop.appointmentWindowStartAt;
        const earlyService: Date | null = early ? maxDate(early, serviceStart ?? early) : null;
        const lateService: Date | null = late ? maxDate(late, serviceStart ?? late) : null;
        const earliestDeparture: Date | null = earlyService ? maxDate(now, addMinutes(earlyService, window.minMinutes)) : null;
        const latestDeparture: Date | null = lateService ? maxDate(now, addMinutes(lateService, window.maxMinutes)) : null;
        result.push({
          tourId: tour.id, stopId: stop.id, sequence: stop.sequence, type: stop.type,
          address: stop.address, city: stop.city ?? null, appointmentAt: stop.appointmentAt,
          appointmentWindowStartAt: stop.appointmentWindowStartAt,
          appointmentWindowEndAt: stop.appointmentWindowEndAt, deadlineAt,
          earliestArrival: early, latestArrival: late, earliestDeparture, latestDeparture,
          predictedEta: early, predictedDelayMinutes: calculateLateMinutes(late, deadlineAt),
          definiteDelayMinutes: calculateLateMinutes(early, deadlineAt),
          riskColor: calculateRiskColor(late, deadlineAt), tourStatus: tour.status as TourStatus,
          preliminary: !early || Boolean(vehicle?.manualStoppedAt)
        });
        // A long stay at the stop counts as a break or a daily rest on the tachograph.
        if (early && earliestDeparture) earlyEngine.idle((earliestDeparture.getTime() - early.getTime()) / 1000, early);
        if (late && latestDeparture) lateEngine.idle((latestDeparture.getTime() - late.getTime()) / 1000, late);
        early = earliestDeparture; late = latestDeparture;
      }
    }
    return result;
  }

  private scheduleByClock(relevant: TourWithStopsAndLegs[], now: Date, anchor: ScheduleAnchor | null): ScheduleStop[] {
    let early: Date | null = now;
    let late: Date | null = now;
    let earlyClock = parseClockState(relevant[0]?.vehicle?.clockState, now);
    let lateClock = structuredClone(earlyClock);
    const vehicle = relevant[0]?.vehicle;
    const breakdown = breakdownTiming(vehicle ?? {}, now);
    if (breakdown.blocked) {
      early = late = breakdown.resumeAt;
      if (breakdown.resumeAt) earlyClock = lateClock = waitClockUntil(earlyClock, breakdown.resumeAt);
    }
    const result: ScheduleStop[] = [];
    for (const tour of relevant) {
      for (const stop of [...tour.stops].sort((a, b) => a.sequence - b.sequence)) {
        if (stop.completedAt) continue;
        const leg = tour.legs.find((item) => item.toStopId === stop.id && item.status !== "COMPLETED");
        if (stop.arrivedAt) {
          early = stop.arrivedAt;
          late = stop.arrivedAt;
        } else if (breakdown.blocked && !breakdown.resumeAt) {
          early = late = null;
        } else if (leg?.startedAt && ["ACTIVE", "ARRIVED"].includes(leg.status) && breakdown.blocked && breakdown.resumeAt) {
          const snapshot = snapshotVehicleClock(vehicle ?? {}, leg, now);
          const forecast = forecastDrive(waitClockUntil(snapshot.clockState, breakdown.resumeAt), Math.max(0, leg.simulatedDurationSeconds - snapshot.driveElapsedSeconds), breakdown.resumeAt);
          early = late = new Date(forecast.endAt);
          earlyClock = lateClock = forecast.state;
        } else if (leg?.startedAt && ["ACTIVE", "ARRIVED"].includes(leg.status)) {
          const stored = readPersistedDrivePlan(leg.drivePlan);
          if (stored) {
            early = late = new Date(stored.clockPlan.endAt);
            earlyClock = lateClock = structuredClone(stored.clockPlan.finalState);
          } else {
            // A leg started without a planned drive: what is left of it is planned on the clock, breaks included.
            const remaining = Math.max(0, leg.simulatedDurationSeconds - snapshotVehicleClock(vehicle ?? {}, leg, now).driveElapsedSeconds);
            if (remaining > 0) {
              const forecast = forecastDrive(forecastClock(earlyClock, now), remaining, now);
              early = late = new Date(forecast.endAt);
              earlyClock = lateClock = forecast.state;
            } else {
              // The timer says the drive is over: the arrival stays where it was due, not «now».
              early = late = new Date(leg.startedAt.getTime() + leg.simulatedDurationSeconds * 1000);
            }
          }
        } else if (leg) {
          if (early && late) {
            const earliest = forecastDrive(earlyClock, leg.simulatedDurationSeconds, early);
            const latest = forecastDrive(lateClock, leg.simulatedDurationSeconds, late);
            early = new Date(earliest.endAt); late = new Date(latest.endAt);
            earlyClock = earliest.state; lateClock = latest.state;
          }
        } else if (tour.approachDurationSeconds != null && result.length === 0 && stop.sequence === 1) {
          const earliest = forecastDrive(earlyClock, tour.approachDurationSeconds, early ?? now);
          const latest = forecastDrive(lateClock, tour.approachDurationSeconds, late ?? now);
          early = new Date(earliest.endAt); late = new Date(latest.endAt);
          earlyClock = earliest.state; lateClock = latest.state;
        } else {
          // A pending stop without an approach leg has no trustworthy ETA.
          early = null;
          late = null;
        }
        if (anchor?.stopId === stop.id && !stop.arrivedAt && !(breakdown.blocked && !breakdown.resumeAt)) early = late = anchor.arrival;
        const window = normalizeServiceWindow(stop.serviceMinMinutes, stop.serviceMaxMinutes);
        const serviceStart = stop.appointmentAt ?? stop.appointmentWindowStartAt;
        const deadlineAt = stop.appointmentAt ?? stop.appointmentWindowEndAt;
        const earlyService: Date | null = early ? maxDate(early, serviceStart ?? early) : null;
        const lateService: Date | null = late ? maxDate(late, serviceStart ?? late) : null;
        const departureFloor = breakdown.resumeAt ?? now;
        const earliestDeparture: Date | null = breakdown.blocked && !breakdown.resumeAt ? null : earlyService ? maxDate(departureFloor, maxDate(now, addMinutes(earlyService, window.minMinutes))) : null;
        const latestDeparture: Date | null = breakdown.blocked && !breakdown.resumeAt ? null : lateService ? maxDate(departureFloor, maxDate(now, addMinutes(lateService, window.maxMinutes))) : null;
        result.push({
          tourId: tour.id, stopId: stop.id, sequence: stop.sequence, type: stop.type,
          address: stop.address, city: stop.city ?? null, appointmentAt: stop.appointmentAt,
          appointmentWindowStartAt: stop.appointmentWindowStartAt,
          appointmentWindowEndAt: stop.appointmentWindowEndAt, deadlineAt,
          earliestArrival: early, latestArrival: late, earliestDeparture, latestDeparture,
          predictedEta: early, predictedDelayMinutes: calculateLateMinutes(late, deadlineAt),
          definiteDelayMinutes: calculateLateMinutes(early, deadlineAt),
          riskColor: calculateRiskColor(late, deadlineAt), tourStatus: tour.status as TourStatus,
          preliminary: breakdown.blocked || !early || earlyClock.kind === "UNKNOWN" || Boolean(tour.vehicle?.manualStoppedAt)
        });
        if (earliestDeparture) earlyClock = waitUntil(earlyClock, earliestDeparture);
        if (latestDeparture) lateClock = waitUntil(lateClock, latestDeparture);
        early = earliestDeparture; late = latestDeparture;
      }
    }
    return result;
  }
}

function waitUntil(clock: ClockState, date: Date): ClockState {
  return applyStopTime(clock, Math.max(0, (date.getTime() - new Date(clock.updatedAt).getTime()) / 1000), clock.updatedAt).state;
}
function maxDate(a: Date, b: Date): Date { return a >= b ? a : b; }
function addMinutes(date: Date, minutes: number): Date { return new Date(date.getTime() + minutes * 60_000); }
