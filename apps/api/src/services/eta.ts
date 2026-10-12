import type { Prisma } from "@prisma/client";
import { compareQueuedItems, normalizeServiceWindow, type RiskColor } from "../domain.js";
import { calculateLateMinutes, calculateRiskColor } from "./simulation.js";
import { applyStopTime, forecastDrive, type ClockState } from "./vehicle-clock.js";
import { parseClockState, readPersistedDrivePlan } from "./tours.js";

type TourStatus = "DRAFT" | "QUEUED" | "ACTIVE" | "COMPLETED" | "CANCELLED";
type TourWithStopsAndLegs = Prisma.TourGetPayload<{ include: { stops: true; legs: true } }> & {
  vehicle?: { clockState?: string | null; manualStoppedAt?: Date | null };
};

export type ScheduleStop = {
  tourId: string; stopId: string; sequence: number; type: string; address: string;
  city: string | null; appointmentAt: Date | null;
  earliestArrival: Date; latestArrival: Date; earliestDeparture: Date; latestDeparture: Date;
  predictedEta: Date; predictedDelayMinutes: number; definiteDelayMinutes: number;
  riskColor: RiskColor; tourStatus: TourStatus; preliminary: boolean;
};

export class EtaService {
  calculateVehicleSchedule(tours: TourWithStopsAndLegs[], now = new Date()): ScheduleStop[] {
    const relevant = tours.filter((tour) => ["ACTIVE", "QUEUED"].includes(tour.status))
      .sort((a, b) => Number(a.status === "QUEUED") - Number(b.status === "QUEUED") || compareQueuedItems(a, b));
    let early = now;
    let late = now;
    let earlyClock = parseClockState(relevant[0]?.vehicle?.clockState, now);
    let lateClock = structuredClone(earlyClock);
    const result: ScheduleStop[] = [];
    for (const tour of relevant) {
      for (const stop of [...tour.stops].sort((a, b) => a.sequence - b.sequence)) {
        if (stop.completedAt) continue;
        const leg = tour.legs.find((item) => item.toStopId === stop.id && item.status !== "COMPLETED");
        if (stop.arrivedAt) {
          early = stop.arrivedAt;
          late = stop.arrivedAt;
        } else if (leg?.startedAt && ["ACTIVE", "ARRIVED"].includes(leg.status)) {
          const stored = readPersistedDrivePlan(leg.drivePlan);
          early = new Date(stored?.clockPlan.endAt ?? leg.startedAt.getTime() + leg.simulatedDurationSeconds * 1000);
          late = early;
          if (stored) earlyClock = lateClock = structuredClone(stored.clockPlan.finalState);
        } else if (leg) {
          const earliest = forecastDrive(earlyClock, leg.simulatedDurationSeconds, early);
          const latest = forecastDrive(lateClock, leg.simulatedDurationSeconds, late);
          early = new Date(earliest.endAt); late = new Date(latest.endAt);
          earlyClock = earliest.state; lateClock = latest.state;
        }
        const window = normalizeServiceWindow(stop.serviceMinMinutes, stop.serviceMaxMinutes);
        const earlyService = maxDate(early, stop.appointmentAt ?? early);
        const lateService = maxDate(late, stop.appointmentAt ?? late);
        const earliestDeparture = maxDate(now, addMinutes(earlyService, window.minMinutes));
        const latestDeparture = maxDate(now, addMinutes(lateService, window.maxMinutes));
        result.push({
          tourId: tour.id, stopId: stop.id, sequence: stop.sequence, type: stop.type,
          address: stop.address, city: stop.city ?? null, appointmentAt: stop.appointmentAt,
          earliestArrival: early, latestArrival: late, earliestDeparture, latestDeparture,
          predictedEta: early, predictedDelayMinutes: calculateLateMinutes(late, stop.appointmentAt),
          definiteDelayMinutes: calculateLateMinutes(early, stop.appointmentAt),
          riskColor: calculateRiskColor(late, stop.appointmentAt), tourStatus: tour.status as TourStatus,
          preliminary: earlyClock.kind === "UNKNOWN" || Boolean(tour.vehicle?.manualStoppedAt)
        });
        earlyClock = waitUntil(earlyClock, earliestDeparture);
        lateClock = waitUntil(lateClock, latestDeparture);
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
