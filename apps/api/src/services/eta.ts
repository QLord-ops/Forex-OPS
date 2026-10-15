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
  appointmentWindowStartAt: Date | null; appointmentWindowEndAt: Date | null; deadlineAt: Date | null;
  earliestArrival: Date | null; latestArrival: Date | null; earliestDeparture: Date | null; latestDeparture: Date | null;
  predictedEta: Date | null; predictedDelayMinutes: number; definiteDelayMinutes: number;
  riskColor: RiskColor; tourStatus: TourStatus; preliminary: boolean;
};

export class EtaService {
  calculateVehicleSchedule(tours: TourWithStopsAndLegs[], now = new Date()): ScheduleStop[] {
    const relevant = tours.filter((tour) => ["ACTIVE", "QUEUED"].includes(tour.status))
      .sort((a, b) => Number(a.status === "QUEUED") - Number(b.status === "QUEUED") || compareQueuedItems(a, b));
    let early: Date | null = now;
    let late: Date | null = now;
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
        const window = normalizeServiceWindow(stop.serviceMinMinutes, stop.serviceMaxMinutes);
        const serviceStart = stop.appointmentAt ?? stop.appointmentWindowStartAt;
        const deadlineAt = stop.appointmentAt ?? stop.appointmentWindowEndAt;
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
          preliminary: !early || earlyClock.kind === "UNKNOWN" || Boolean(tour.vehicle?.manualStoppedAt)
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
