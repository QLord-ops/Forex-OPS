import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { TourPlanConflictError, TourService, snapshotVehicleClock, rebaseActiveLeg } from './tours.js';
import {
  createInitialClockState, getBerlinIsoWeekKey, reserveCycleExtension, releaseCycleExtension,
  forecastDrive, applyStopTime, resetReducedRestCounter, type ClockState
} from './vehicle-clock.js';

export type ExceptionKind = 'EXTENDED_DRIVING' | 'REDUCED_REST' | 'BOTH';

export class OperationsService {
  constructor(private readonly db: PrismaClient, private readonly tours: TourService) {}

  async context(vehicleId: string, now = new Date()) {
    const vehicle = await this.db.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    const tours = await this.db.tour.findMany({
      where: { vehicleId, status: { in: ['ACTIVE', 'QUEUED'] } },
      orderBy: [{ queueIndex: 'asc' }, { createdAt: 'asc' }],
      include: { stops: { orderBy: { sequence: 'asc' } }, legs: true }
    });
    const activeTour = tours.find(tour => tour.status === 'ACTIVE');
    const currentStop = activeTour?.stops.find(stop => !stop.completedAt) ?? null;
    const activeLeg = activeTour?.legs.find(leg => (leg.status === 'ACTIVE' || leg.status === 'ARRIVED') && !currentStop?.arrivedAt) ?? null;
    const snapshot = snapshotVehicleClock(vehicle, activeLeg, now);
    return { vehicle, tours, activeTour, currentStop, activeLeg, snapshot };
  }

  async get(vehicleId: string, now = new Date()) {
    const context = await this.context(vehicleId, now);
    const { vehicle, currentStop, snapshot } = context;
    return {
      vehicleId, version: vehicle.operationVersion, clock: snapshot.clockState,
      preliminary: snapshot.clockState.kind !== 'KNOWN', manualStoppedAt: vehicle.manualStoppedAt,
      position: await this.tours.getCurrentPosition(vehicleId, now), currentStop,
      dwellMinutes: currentStop?.arrivedAt ? Math.max(0, Math.floor((now.getTime() - currentStop.arrivedAt.getTime()) / 60_000)) : null,
      clockProposals: this.proposals(context, now),
      traffic: context.activeLeg?.routeDetails ? JSON.parse(context.activeLeg.routeDetails) : null
    };
  }

  private proposals(context: Awaited<ReturnType<OperationsService['context']>>, now: Date) {
    if (context.snapshot.clockState.kind !== 'KNOWN') return [];
    const baseline = this.project(context, context.snapshot.clockState, now);
    const proposals: Array<{ kind: ExceptionKind; stopId: string; ordinaryEta: string; newEta: string; gainMinutes: number; extendedRemaining: number; reducedRemaining: number }> = [];
    for (const kind of ['EXTENDED_DRIVING', 'REDUCED_REST', 'BOTH'] as const) {
      const clock = this.reserve(context.snapshot.clockState, kind, now);
      if (!clock) continue;
      const candidate = this.project(context, clock, now);
      const rescued = candidate.find(item => {
        const original = baseline.find(base => base.stopId === item.stopId);
        return item.appointmentAt && original && original.eta > item.appointmentAt && item.eta <= item.appointmentAt;
      });
      if (!rescued) continue;
      const normal = baseline.find(item => item.stopId === rescued.stopId)!;
      proposals.push({ kind, stopId: rescued.stopId, ordinaryEta: normal.eta.toISOString(),
        newEta: rescued.eta.toISOString(), gainMinutes: Math.floor((normal.eta.getTime() - rescued.eta.getTime()) / 60_000),
        extendedRemaining: Math.max(0, 2 - clock.weeklyExtendedDrive.used),
        reducedRemaining: Math.max(0, 3 - clock.reducedRestsSinceWeeklyRest) });
    }
    // A combined proposal is useful only when neither single exception solves that deadline.
    return proposals.filter(item => item.kind !== 'BOTH' || !proposals.some(single => single.kind !== 'BOTH' && single.stopId === item.stopId));
  }

  private project(context: Awaited<ReturnType<OperationsService['context']>>, clock: ClockState, now: Date) {
    let state = clock;
    let cursor = now;
    const result: Array<{ stopId: string; eta: Date; appointmentAt: Date | null }> = [];
    for (const tour of context.tours) for (const stop of tour.stops) {
      if (stop.completedAt) continue;
      const leg = tour.legs.find(item => item.toStopId === stop.id);
      if (leg && !stop.arrivedAt && leg.status !== 'COMPLETED') {
        const seconds = leg.id === context.activeLeg?.id
          ? Math.max(0, leg.simulatedDurationSeconds - context.snapshot.driveElapsedSeconds)
          : leg.simulatedDurationSeconds;
        const forecast = forecastDrive(state, seconds, cursor);
        cursor = new Date(forecast.endAt); state = forecast.state;
      }
      result.push({ stopId: stop.id, eta: cursor, appointmentAt: stop.appointmentAt });
      const wait = Math.max(0, (stop.appointmentAt?.getTime() ?? 0) - cursor.getTime()) / 1000;
      const elapsedDwell = stop.arrivedAt ? Math.max(0, (now.getTime() - stop.arrivedAt.getTime()) / 1000) : 0;
      const duration = wait + Math.max(0, stop.serviceMaxMinutes * 60 - elapsedDwell);
      state = applyStopTime(state, duration, cursor).state;
      cursor = new Date(cursor.getTime() + duration * 1000);
    }
    return result;
  }

  private reserve(clock: ClockState, kind: ExceptionKind, now: Date) {
    let next = clock;
    for (const type of kind === 'BOTH' ? ['EXTENDED_DRIVE', 'REDUCED_REST'] as const : [kind === 'EXTENDED_DRIVING' ? 'EXTENDED_DRIVE' : 'REDUCED_REST'] as const) {
      const reserved = reserveCycleExtension(next, { type, reservationId: `${next.currentCycle.cycleId}:${type}`, requestedAt: now });
      if (!reserved.accepted) return null;
      next = reserved.state;
    }
    return next;
  }

  async setClock(vehicleId: string, input: {
    version: number; cycleStartedAt: string; dailyDrivingMinutes: number; drivingSinceBreakMinutes: number;
    extendedDrivingUsed: number; reducedRestUsed: number; reason: string;
    currentExtendedDriving?: boolean; currentReducedRest?: boolean;
  }, now = new Date()) {
    const startedAt = new Date(input.cycleStartedAt);
    if (startedAt > now) throw new TourPlanConflictError('Начало рабочего периода не может быть в будущем.');
    if (input.dailyDrivingMinutes > (now.getTime() - startedAt.getTime()) / 60_000) throw new TourPlanConflictError('Время вождения превышает рабочий период.');
    if ((input.currentExtendedDriving && input.extendedDrivingUsed < 1) || (input.currentReducedRest && input.reducedRestUsed < 1)) throw new TourPlanConflictError('Текущее исключение должно быть учтено в расходе.');
    const clock = createInitialClockState({
      effectiveAt: now, cycleId: randomUUID(), drivingSeconds: input.dailyDrivingMinutes * 60,
      continuousDrivingSeconds: input.drivingSinceBreakMinutes * 60, dutySeconds: Math.floor((now.getTime() - startedAt.getTime()) / 1000),
      extendedDriveReservationId: input.currentExtendedDriving ? `initial-drive-${now.toISOString()}` : null,
      reducedRestReservationId: input.currentReducedRest ? `initial-rest-${now.toISOString()}` : null,
      weeklyExtendedDrive: { weekKey: getBerlinIsoWeekKey(now), used: input.extendedDrivingUsed },
      reducedRestsSinceWeeklyRest: input.reducedRestUsed
    });
    clock.currentCycle.startedAt = startedAt.toISOString();
    await this.changeClock(vehicleId, input.version, clock, 'CLOCK_CORRECTION', input.reason, now);
    return this.get(vehicleId, now);
  }

  async acceptException(vehicleId: string, version: number, kind: ExceptionKind, now = new Date()) {
    const context = await this.context(vehicleId, now);
    const cycle = context.snapshot.clockState.currentCycle;
    if ((kind !== 'REDUCED_REST' ? Boolean(cycle.extendedDriveReservationId) : true) &&
        (kind !== 'EXTENDED_DRIVING' ? Boolean(cycle.reducedRestReservationId) : true)) return this.get(vehicleId, now);
    if (!this.proposals(context, now).some(item => item.kind === kind)) throw new TourPlanConflictError('Нет подходящего предложения для соблюдения срока.');
    const clock = this.reserve(context.snapshot.clockState, kind, now);
    if (!clock) throw new TourPlanConflictError('Исключения исчерпаны.');
    await this.changeClock(vehicleId, version, clock, 'EXCEPTION_RESERVED', kind, now);
    return this.get(vehicleId, now);
  }

  async cancelExceptions(vehicleId: string, version: number, now = new Date()) {
    let clock = (await this.context(vehicleId, now)).snapshot.clockState;
    for (const [type, reservationId] of [
      ['EXTENDED_DRIVE', clock.currentCycle.extendedDriveReservationId],
      ['REDUCED_REST', clock.currentCycle.reducedRestReservationId]
    ] as const) {
      if (!reservationId) continue;
      const result = releaseCycleExtension(clock, { type, reservationId });
      if (!result.accepted) throw new TourPlanConflictError('Уже использованное исключение нельзя отменить.');
      clock = result.state;
    }
    await this.changeClock(vehicleId, version, clock, 'EXCEPTION_RELEASED', 'Disposition', now);
    return this.get(vehicleId, now);
  }

  async weeklyRest(vehicleId: string, version: number, reason: string, now = new Date()) {
    const context = await this.context(vehicleId, now);
    if (context.activeLeg && !context.vehicle.manualStoppedAt) throw new TourPlanConflictError('Во время движения нельзя подтвердить еженедельный отдых.');
    const previous = context.snapshot.clockState;
    if (previous.kind !== 'KNOWN') throw new TourPlanConflictError('Сначала укажите исходные данные.');
    const clock = createInitialClockState({ effectiveAt: now, weeklyExtendedDrive: previous.weeklyExtendedDrive });
    await this.changeClock(vehicleId, version, resetReducedRestCounter(clock, now), 'WEEKLY_REST_CONFIRMED', reason, now);
    return this.get(vehicleId, now);
  }

  private async changeClock(vehicleId: string, version: number, clock: ClockState, type: string, reason: string, now: Date) {
    await this.db.$transaction(async tx => {
      const changed = await tx.vehicle.updateMany({ where: { id: vehicleId, operationVersion: version },
        data: { clockState: JSON.stringify(clock), operationVersion: { increment: 1 } } });
      if (!changed.count) throw new TourPlanConflictError('Состояние грузовика изменилось. Обновите страницу.');
      await rebaseActiveLeg(tx, vehicleId, clock, now);
      await tx.operationEvent.create({ data: { vehicleId, type, reason, payloadJson: JSON.stringify(clock), createdAt: now } });
    });
  }

  async confirmArrival(stopId: string, arrivedAt: Date, now = new Date()) {
    if (arrivedAt > now) throw new TourPlanConflictError('Время прибытия не может быть в будущем.');
    await this.db.$transaction(async tx => {
      const stop = await tx.stop.findUniqueOrThrow({ where: { id: stopId }, include: { tour: { include: { vehicle: true, stops: { orderBy: { sequence: 'asc' } }, legs: true } } } });
      if (stop.tour.status !== 'ACTIVE' || stop.completedAt || stop.tour.stops.find(item => !item.completedAt)?.id !== stopId) throw new TourPlanConflictError('Можно подтвердить только следующую активную точку.');
      if (stop.arrivedAt) return;
      const leg = stop.tour.legs.find(item => item.toStopId === stop.id);
      if (leg?.startedAt && arrivedAt < leg.startedAt) throw new TourPlanConflictError('Прибытие не может быть раньше начала движения.');
      const clock = snapshotVehicleClock(stop.tour.vehicle, leg ?? null, arrivedAt).clockState;
      await tx.stop.update({ where: { id: stopId }, data: { arrivedAt } });
      if (leg) await tx.leg.update({ where: { id: leg.id }, data: { status: 'ARRIVED' } });
      await tx.vehicle.update({ where: { id: stop.tour.vehicleId }, data: { clockState: JSON.stringify(clock), manualStoppedAt: null, operationVersion: { increment: 1 } } });
      await tx.tour.update({ where: { id: stop.tourId }, data: { planVersion: { increment: 1 } } });
      await tx.notification.updateMany({ where: { stopId, type: 'PREDICTED_ARRIVAL', acknowledgedAt: null }, data: { acknowledgedAt: now } });
      await tx.operationEvent.create({ data: { vehicleId: stop.tour.vehicleId, tourId: stop.tourId, stopId, type: 'ARRIVAL_CONFIRMED', payloadJson: JSON.stringify({ arrivedAt }), createdAt: now } });
    });
    return { ok: true };
  }

  async manualStop(vehicleId: string, version: number, now = new Date()) {
    const context = await this.context(vehicleId, now);
    if (!context.activeLeg || context.currentStop?.arrivedAt) throw new TourPlanConflictError('Нет активного движения.');
    await this.db.$transaction(async tx => {
      const changed = await tx.vehicle.updateMany({ where: { id: vehicleId, operationVersion: version, manualStoppedAt: null },
        data: { manualStoppedAt: now, operationVersion: { increment: 1 }, clockState: JSON.stringify(context.snapshot.clockState) } });
      if (!changed.count) throw new TourPlanConflictError('Состояние грузовика изменилось или он уже остановлен.');
      await tx.operationEvent.create({ data: { vehicleId, type: 'MANUAL_STOP', payloadJson: JSON.stringify({ at: now }) } });
    });
    return this.get(vehicleId, now);
  }

  async resume(vehicleId: string, version: number, now = new Date()) {
    const context = await this.context(vehicleId, now);
    if (!context.vehicle.manualStoppedAt) throw new TourPlanConflictError('Грузовик не был остановлен вручную.');
    await this.db.$transaction(async tx => {
      const breakdown = await tx.vehicleIssue.findFirst({ where: { vehicleId, kind: 'BREAKDOWN', resolvedAt: null } });
      if (breakdown) throw new TourPlanConflictError('Сначала подтвердите завершение ремонта машины.');
      // Rebase while the frozen timestamp is still available, then release movement.
      await rebaseActiveLeg(tx, vehicleId, context.snapshot.clockState, now);
      const changed = await tx.vehicle.updateMany({ where: { id: vehicleId, operationVersion: version },
        data: { manualStoppedAt: null, clockState: JSON.stringify(context.snapshot.clockState), operationVersion: { increment: 1 } } });
      if (!changed.count) throw new TourPlanConflictError('Состояние грузовика изменилось.');
      await tx.operationEvent.create({ data: { vehicleId, type: 'MOVEMENT_RESUMED', payloadJson: JSON.stringify({ at: now }) } });
    });
    return this.get(vehicleId, now);
  }
}
