import type { PrismaClient } from '@prisma/client';
import type { CurrentPosition, RiskColor } from '../domain.js';
import { AssistantError } from './dispatcher-assistant.js';
import type { EtaService } from './eta.js';
import { dailyRestOf, type DailyRest } from './rest-at-stop.js';
import { berlinLocal, formatSeconds } from './termin-planner.js';
import { stopLabel, type DriverHoursReader } from './termin-service.js';
import type { DriverHours } from './webfleet-live.js';

export type BriefStop = {
  stopId: string; tourId: string; sequence: number; type: string; label: string; company: string | null; city: string | null; address: string;
  appointmentAt: string | null; appointmentAtLocal: string | null; windowStartAt: string | null; windowEndAt: string | null; plannedAt: string | null;
  terminRequired: boolean; serviceMinMinutes: number; serviceMaxMinutes: number; arrivedAt: string | null; completedAt: string | null;
  eta: { earliest: string | null; earliestLocal: string | null; latest: string | null; latestLocal: string | null; risk: RiskColor; preliminary: boolean } | null;
};
export type VehicleBrief = {
  kind: 'VEHICLE_BRIEF'; generatedAt: string; vehicleId: string; vehicleNumber: string; licensePlate: string | null; trailerPlate: string | null;
  manualStoppedAt: string | null; calculatedClockPreliminary: boolean;
  position: { status: CurrentPosition['status']; state: CurrentPosition['state']; address: string | null; source: 'WEBFLEET' | 'CALCULATED' | 'MANUAL' | null; ageMinutes: number | null; stale: boolean; remainingKm: number | null };
  activeTour: { tourId: string; orderNumber: string; currentStopId: string | null; stops: BriefStop[] } | null;
  queuedTours: Array<{ tourId: string; orderNumber: string; plannedStartAt: string | null; plannedStartAtLocal: string | null; stops: BriefStop[] }>;
  driver: {
    status: DriverHours['status']; workStateLabel: string | null; activitySince: string | null; restingNow: DailyRest | null;
    hours: { referenceTime: string; drivenToday: string; leftToday: string; untilBreak: string; breakMin: string; restLatestAt: string | null; restMin: string;
      shiftEndAt: string | null; earliestNextShiftAt: string | null; extendedLeft: number | null; reducedLeft: number | null; weekLeft: string; infringements: boolean } | null;
    summary: string;
  };
  issues: Array<{ id: string; kind: string; description: string; expectedResolvedAt: string | null }>;
};

const WORK_STATE: Record<number, string> = { 1: 'свободное время', 2: 'пауза', 3: 'готовность', 4: 'работа', 5: 'за рулём', 6: 'другая работа' };

/** What the dispatcher and the assistant need to know about one truck, in words: no raw rows, no driver identity. */
export class VehicleBriefService {
  constructor(private readonly db: PrismaClient, private readonly eta: EtaService,
    private readonly getPosition: (id: string, now: Date) => Promise<CurrentPosition>,
    private readonly driverHours: DriverHoursReader,
    private readonly latestAddress: (id: string, now: Date) => Promise<string | null> = async () => null) {}

  async build(vehicleId: string, now = new Date()): Promise<VehicleBrief> {
    const vehicle = await this.db.vehicle.findUnique({ where: { id: vehicleId }, include: {
      issues: { where: { resolvedAt: null } },
      tours: { where: { status: { in: ['ACTIVE', 'QUEUED'] } }, orderBy: [{ queueIndex: 'asc' }, { createdAt: 'asc' }], include: { stops: { orderBy: { sequence: 'asc' } }, legs: true } }
    } });
    if (!vehicle) throw new AssistantError('Машина не найдена.', 404);
    const [position, hours, address] = await Promise.all([this.getPosition(vehicle.id, now), this.driverHours(vehicle.id, now), this.latestAddress(vehicle.id, now).catch(() => null)]);
    const tours = vehicle.tours.map(tour => ({ ...tour, vehicle: { clockState: vehicle.clockState, manualStoppedAt: vehicle.manualStoppedAt, issues: vehicle.issues } }));
    const schedule = this.eta.calculateVehicleSchedule(tours, now);
    const etaOf = (stopId: string) => {
      const row = schedule.find(item => item.stopId === stopId);
      return row ? { earliest: row.earliestArrival?.toISOString() ?? null, earliestLocal: row.earliestArrival ? berlinLocal(row.earliestArrival, now) : null,
        latest: row.latestArrival?.toISOString() ?? null, latestLocal: row.latestArrival ? berlinLocal(row.latestArrival, now) : null, risk: row.riskColor, preliminary: row.preliminary } : null;
    };
    const brief = (tour: typeof tours[number]): BriefStop[] => tour.stops.map(stop => ({
      stopId: stop.id, tourId: tour.id, sequence: stop.sequence, type: stop.type, label: stopLabel(stop), company: stop.company ?? null, city: stop.city ?? null, address: stop.address,
      appointmentAt: stop.appointmentAt?.toISOString() ?? null, appointmentAtLocal: stop.appointmentAt ? berlinLocal(stop.appointmentAt, now) : null,
      windowStartAt: stop.appointmentWindowStartAt?.toISOString() ?? null, windowEndAt: stop.appointmentWindowEndAt?.toISOString() ?? null, plannedAt: stop.plannedAt?.toISOString() ?? null,
      terminRequired: stop.terminRequired, serviceMinMinutes: stop.serviceMinMinutes, serviceMaxMinutes: stop.serviceMaxMinutes,
      arrivedAt: stop.arrivedAt?.toISOString() ?? null, completedAt: stop.completedAt?.toISOString() ?? null, eta: stop.completedAt ? null : etaOf(stop.id)
    }));
    const active = tours.find(tour => tour.status === 'ACTIVE') ?? null;
    const restingNow = dailyRestOf({ workState: hours.workState, activitySince: hours.activitySince, times: hours.times, now });
    const times = hours.times;
    const driverHours = times ? {
      referenceTime: times.referenceTime ?? now.toISOString(),
      drivenToday: ms(times.totalDrivingTodayMs), leftToday: ms(times.remainDrivingTodayMs),
      untilBreak: times.nextBreakAt && times.referenceTime ? formatSeconds((Date.parse(times.nextBreakAt) - Date.parse(times.referenceTime)) / 1000) : '–',
      breakMin: ms(times.nextBreakMinMs), restLatestAt: times.nextRestAt, restMin: ms(times.nextRestMinMs),
      shiftEndAt: times.latestShiftEndAt, earliestNextShiftAt: times.earliestNextShiftAt,
      extendedLeft: left(times.maxExtendedShifts, times.extendedShiftsUsed), reducedLeft: left(times.maxReducedRests, times.reducedRestsUsed),
      weekLeft: ms(times.remainDrivingWeekMs), infringements: times.infringements
    } : null;
    const workStateLabel = hours.workState !== null ? WORK_STATE[hours.workState] ?? null : null;
    const summary = hours.status === 'NO_WEBFLEET' ? 'Машина не привязана к Webfleet: часов водителя нет.'
      : hours.status === 'NONE' ? 'Карта водителя не вставлена: часов по тахографу нет.'
      : !driverHours ? 'Данные тахографа Webfleet ещё не получены.'
      : restingNow ? `Водитель на суточном отдыхе${restingNow.until ? ` до ${berlinLocal(restingNow.until, now)}` : ''}; сегодня ездил ${driverHours.drivenToday}.`
      : `Сегодня ездил ${driverHours.drivenToday}, осталось ${driverHours.leftToday}, до перерыва ${driverHours.untilBreak}${driverHours.restLatestAt ? `, суточный отдых не позже ${berlinLocal(driverHours.restLatestAt, now)}` : ''}${workStateLabel ? ` · сейчас ${workStateLabel}` : ''}.`;
    return {
      kind: 'VEHICLE_BRIEF', generatedAt: now.toISOString(), vehicleId: vehicle.id, vehicleNumber: vehicle.vehicleNumber, licensePlate: vehicle.licensePlate, trailerPlate: vehicle.currentTrailerPlate,
      manualStoppedAt: vehicle.manualStoppedAt?.toISOString() ?? null, calculatedClockPreliminary: schedule.some(row => row.preliminary),
      position: { status: position.status, state: position.state, address: position.positionSource === 'WEBFLEET' ? address : null, source: position.positionSource ?? null,
        ageMinutes: position.telemetryAgeSeconds != null ? Math.round(position.telemetryAgeSeconds / 60) : null, stale: Boolean(position.telemetryStale),
        remainingKm: position.legId ? Math.round(position.remainingDistanceMeters / 1000) : null },
      activeTour: active ? { tourId: active.id, orderNumber: active.orderNumber, currentStopId: active.stops.find(stop => !stop.completedAt)?.id ?? null, stops: brief(active) } : null,
      queuedTours: tours.filter(tour => tour.status === 'QUEUED').map(tour => ({ tourId: tour.id, orderNumber: tour.orderNumber, plannedStartAt: tour.plannedStartAt?.toISOString() ?? null,
        plannedStartAtLocal: tour.plannedStartAt ? berlinLocal(tour.plannedStartAt, now) : null, stops: brief(tour) })),
      driver: { status: hours.status, workStateLabel, activitySince: hours.activitySince, restingNow, hours: driverHours, summary },
      issues: vehicle.issues.map(issue => ({ id: issue.id, kind: issue.kind, description: issue.description, expectedResolvedAt: issue.expectedResolvedAt?.toISOString() ?? null }))
    };
  }
}

function ms(value: number | null): string { return value === null ? '–' : value < 0 ? `превышено на ${formatSeconds(-value / 1000)}` : formatSeconds(value / 1000); }
function left(max: number | null, used: number | null): number | null { return max === null || used === null ? null : Math.max(0, max - used); }
