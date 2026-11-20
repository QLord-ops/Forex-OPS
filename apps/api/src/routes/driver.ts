import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAuditLog } from '../services/audit-log.js';
import { driverActor, type DriverSession } from '../services/driver-auth.js';
import type { OperationsService } from '../services/operations.js';
import { coverResolver, coveredStatusOwner } from '../services/covers.js';
import { samePlace } from '../services/termin-groups.js';
import { DRIVER_UNDO_MS, driverGpsText, offlineText, type DriverGpsCheck, type TourService } from '../services/tours.js';
import { DEFAULT_ARRIVAL_RADIUS_METERS, distanceMeters } from '../services/webfleet.js';

type Gps = { latitude: number; longitude: number; stale: boolean; ageSeconds: number } | null;
export type DriverEta = { at: string | null; source: 'WEBFLEET' | 'WEBFLEET_STALE' | 'CALCULATED' };

export interface DriverRouteDeps {
  prisma: PrismaClient;
  tours: Pick<TourService, 'recordLoaded' | 'recordUnloaded' | 'revertAutoStopEvent'>;
  operations: Pick<OperationsService, 'confirmArrival'>;
  /** The truck's latest Webfleet fix; the phone's own position is never used (CLAUDE.md rule 3). */
  gps(vehicleId: string, now: Date): Promise<Gps>;
  eta(vehicleId: string, now: Date): Promise<DriverEta | null>;
  /** After a mark: alerts and learned gates follow, as after a dispatcher's mark. */
  afterEvent(vehicleId: string, stopIds: string[]): Promise<void>;
  now?: () => Date;
}

export const DRIVER_PROBLEMS = { WAITING: 'долгое ожидание', NO_GOODS: 'груз не готов', DAMAGE: 'повреждение груза или машины', ADDRESS: 'не тот адрес или ворота', OTHER: 'другое' } as const;

const idParams = z.object({ id: z.string().trim().min(1).max(64) }).strict();
/** A mark the phone kept while it had no network carries the moment the driver pressed the button. */
const markBody = z.object({ at: z.string().datetime().optional() }).strict();
/** Older marks are no longer the driver's to send: the dispatcher sorts them out. */
export const OFFLINE_MARK_MAX_MS = 12 * 3_600_000;
const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const berlinClock = (value: Date) => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(value);

export function driverGpsCheck(gps: Gps, stop: { latitude: number; longitude: number; arrivalRadiusMeters: number | null }): DriverGpsCheck {
  if (!gps) return { status: 'NONE', distanceMeters: null, ageMinutes: null };
  const meters = Math.round(distanceMeters(gps.latitude, gps.longitude, stop.latitude, stop.longitude));
  const ageMinutes = Math.max(0, Math.round(gps.ageSeconds / 60));
  if (gps.stale) return { status: 'STALE', distanceMeters: meters, ageMinutes };
  return { status: meters <= (stop.arrivalRadiusMeters ?? DEFAULT_ARRIVAL_RADIUS_METERS) ? 'IN_ZONE' : 'AWAY', distanceMeters: meters, ageMinutes };
}

function references(json: string | null): string[] {
  try {
    const value: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** Everything the driver app shows. Only this truck's tours; no other truck, no dispatcher names, no prices. */
export function registerDriverRoutes(app: FastifyInstance, deps: DriverRouteDeps) {
  const { prisma } = deps;
  const clock = deps.now ?? (() => new Date());
  const sessionOf = (request: FastifyRequest): DriverSession => {
    if (!request.driverSession) throw fail('Войдите по коду смены.', 401);
    return request.driverSession;
  };
  const actions = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  /**
   * The dispatcher the driver calls: who took the truck, the stand-in while that one is covered, else the dispatcher of
   * the truck's line (as for the status list). Only the name and the work phone, nothing else of the account.
   */
  async function dispatcherOf(vehicleId: string, now: Date) {
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { assignedDispatcherId: true, customerLineId: true,
      customerLine: { select: { dispatchers: { select: { dispatcherId: true, isPrimary: true } } } } } });
    if (!vehicle) return null;
    const owner = coveredStatusOwner(await coverResolver(prisma, now), vehicle, vehicle.customerLine?.dispatchers ?? []);
    if (!owner) return null;
    const person = await prisma.dispatcher.findUnique({ where: { id: owner.id }, select: { displayName: true, workPhone: true, active: true } });
    return person?.active ? { name: person.displayName, phone: person.workPhone } : null;
  }

  async function tourView(vehicleId: string, now: Date) {
    const [vehicle, tour, queued, dispatcher] = await Promise.all([
      prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId }, select: { vehicleNumber: true, licensePlate: true } }),
      prisma.tour.findFirst({ where: { vehicleId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, include: { stops: { orderBy: { sequence: 'asc' } } } }),
      prisma.tour.findFirst({ where: { vehicleId, status: 'QUEUED' }, orderBy: [{ queueIndex: 'asc' }, { createdAt: 'asc' }], include: { stops: { orderBy: { sequence: 'asc' }, take: 1 } } }),
      dispatcherOf(vehicleId, now)
    ]);
    const next = queued ? { orderNumber: queued.orderNumber, company: queued.stops[0]?.company ?? null, city: queued.stops[0]?.city ?? null,
      appointmentAt: (queued.stops[0]?.appointmentAt ?? queued.stops[0]?.appointmentWindowStartAt)?.toISOString() ?? null } : null;
    // The driver's own marks that can still be taken back.
    const marks = await prisma.operationEvent.findMany({ where: { vehicleId, type: 'STOP_EVENT_DRIVER', createdAt: { gt: new Date(now.getTime() - DRIVER_UNDO_MS) } }, orderBy: { createdAt: 'desc' } });
    const standing = (mark: (typeof marks)[number], completedAt: Date | null) => completedAt !== null && (JSON.parse(mark.payloadJson) as { at?: string }).at === completedAt.toISOString();
    // The last stop of a tour closes the tour: its mark is no longer among the current stops, but can still be taken back.
    const closing = marks.find(mark => mark.tourId !== tour?.id) ?? null;
    const closed = closing?.stopId ? await prisma.stop.findUnique({ where: { id: closing.stopId }, include: { tour: { select: { orderNumber: true, status: true } } } }) : null;
    const lastMark = closing && closed && closed.tour.status === 'COMPLETED' && standing(closing, closed.completedAt)
      ? { stopId: closed.id, type: closed.type, company: closed.company, city: closed.city, orderNumber: closed.tour.orderNumber, completedAt: closed.completedAt!.toISOString(),
        undoUntil: new Date(closing.createdAt.getTime() + DRIVER_UNDO_MS).toISOString() }
      : null;
    if (!tour) return { serverTime: now.toISOString(), vehicle, dispatcher, tour: null, next, lastMark };
    const current = tour.stops.find(stop => !stop.completedAt) ?? null;
    const eta = current && !current.arrivedAt ? await deps.eta(vehicleId, now).catch(() => null) : null;
    return {
      serverTime: now.toISOString(), vehicle, dispatcher, next, lastMark,
      tour: {
        id: tour.id, orderNumber: tour.orderNumber, tourRemarks: tour.tourRemarks, trailerPlate: tour.trailerPlate, currentStopId: current?.id ?? null, eta,
        stops: tour.stops.map((stop, index) => {
          const mark = marks.find(item => item.stopId === stop.id);
          const own = mark && standing(mark, stop.completedAt);
          return {
            id: stop.id, sequence: stop.sequence, type: stop.type, company: stop.company, address: stop.address, city: stop.city,
            latitude: stop.latitude, longitude: stop.longitude,
            appointmentAt: stop.appointmentAt?.toISOString() ?? null, windowStartAt: stop.appointmentWindowStartAt?.toISOString() ?? null, windowEndAt: stop.appointmentWindowEndAt?.toISOString() ?? null,
            loadingMeters: stop.loadingMeters, references: references(stop.referenceNumbersJson), instructions: stop.instructions,
            arrivedAt: stop.arrivedAt?.toISOString() ?? null, completedAt: stop.completedAt?.toISOString() ?? null,
            samePlaceAsPrevious: index > 0 && samePlace(tour.stops[index - 1], stop),
            undoUntil: own ? new Date(mark.createdAt.getTime() + DRIVER_UNDO_MS).toISOString() : null
          };
        })
      }
    };
  }

  /** The stop must belong to the truck the phone is signed in for; another truck's stop does not exist for it. */
  async function ownStop(request: FastifyRequest) {
    const session = sessionOf(request);
    const { id } = idParams.parse(request.params);
    const stop = await prisma.stop.findUnique({ where: { id }, include: { tour: { include: { vehicle: { select: { vehicleNumber: true } }, stops: { orderBy: { sequence: 'asc' } } } } } });
    if (!stop || stop.tour.vehicleId !== session.vehicleId) throw fail('Точка не найдена.', 404);
    return { session, stop };
  }

  app.get('/driver/tour', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return tourView(sessionOf(request).vehicleId, clock());
  });

  /** When the driver pressed the button: now, or the moment kept on the phone while there was no network. */
  function markTime(body: unknown, now: Date): Date {
    const { at } = markBody.parse(body ?? {});
    if (!at) return now;
    const pressed = new Date(at);
    if (now.getTime() - pressed.getTime() > OFFLINE_MARK_MAX_MS) throw fail('Отметка без сети старше 12 часов — сообщите диспетчеру, он запишет её сам.', 409);
    // The phone's clock runs a little ahead: a mark is never in the future.
    return pressed > now ? now : pressed;
  }

  app.post('/driver/stops/:id/arrived', actions, async request => {
    const { session, stop } = await ownStop(request);
    const now = clock();
    const at = markTime(request.body, now);
    const gps = driverGpsCheck(await deps.gps(session.vehicleId, at), stop);
    const result = await deps.operations.confirmArrival(stop.id, at, now, driverActor(session), { source: 'DRIVER', meta: { gps, ...(at < now ? { pressedAt: at.toISOString() } : {}) } });
    if (result.applied) {
      const place = [stop.company, stop.city || stop.address].filter(Boolean).join(', ');
      const dedupKey = `driver-arrival:${stop.id}`;
      const message = `Водитель LKW ${stop.tour.vehicle.vehicleNumber} отметил прибытие ${stop.type === 'LOAD' ? 'на загрузку' : 'на выгрузку'} в ${berlinClock(at)}${offlineText(at, now)} — ${place}. ${driverGpsText(gps)} Если это ошибка, отмените прибытие.`;
      const payloadJson = JSON.stringify({ source: 'DRIVER', arrivedAt: at.toISOString(), gps, ...(at < now ? { receivedAt: now.toISOString() } : {}) });
      await prisma.notificationRead.deleteMany({ where: { notification: { dedupKey } } });
      await prisma.notification.upsert({ where: { dedupKey }, create: { dedupKey, vehicleId: session.vehicleId, stopId: stop.id, type: 'DRIVER_ARRIVAL', message, payloadJson },
        update: { message, payloadJson, acknowledgedAt: null } });
      await deps.afterEvent(session.vehicleId, []);
    }
    return tourView(session.vehicleId, now);
  });

  app.post('/driver/stops/:id/done', actions, async request => {
    const { session, stop } = await ownStop(request);
    const now = clock();
    const index = stop.tour.stops.findIndex(item => item.id === stop.id);
    const previous = index > 0 ? stop.tour.stops[index - 1] : null;
    // Leergut after unloading at the same plant: the truck never moved, the arrival comes with the mark.
    const follower = Boolean(previous?.completedAt && samePlace(previous, stop));
    if (!stop.arrivedAt && !follower) throw fail('Сначала нажмите «Прибыл».', 409);
    const at = markTime(request.body, now);
    const gps = driverGpsCheck(await deps.gps(session.vehicleId, at), stop);
    const record = stop.type === 'LOAD' ? deps.tours.recordLoaded : deps.tours.recordUnloaded;
    await record.call(deps.tours, stop.id, at, undefined, driverActor(session), { arriveWithEvent: !stop.arrivedAt, driver: { gps, receivedAt: now } });
    await deps.afterEvent(session.vehicleId, [stop.id]);
    return tourView(session.vehicleId, now);
  });

  app.post('/driver/stops/:id/undo', actions, async request => {
    const { session, stop } = await ownStop(request);
    const now = clock();
    await deps.tours.revertAutoStopEvent(stop.id, now, driverActor(session), undefined, { vehicleId: session.vehicleId });
    await deps.afterEvent(session.vehicleId, []);
    return tourView(session.vehicleId, now);
  });

  app.post('/driver/stops/:id/problem', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async request => {
    const { session, stop } = await ownStop(request);
    const body = z.object({ kind: z.enum(Object.keys(DRIVER_PROBLEMS) as [keyof typeof DRIVER_PROBLEMS, ...Array<keyof typeof DRIVER_PROBLEMS>]), note: z.string().trim().max(300).optional() }).strict().parse(request.body);
    if (stop.tour.status !== 'ACTIVE') throw fail('Сообщить можно только по текущему туру.', 409);
    const now = clock();
    const place = [stop.company, stop.city || stop.address].filter(Boolean).join(', ');
    const payload = { kind: body.kind, note: body.note || null, at: now.toISOString() };
    await prisma.$transaction(async tx => {
      await tx.operationEvent.create({ data: { vehicleId: session.vehicleId, tourId: stop.tourId, stopId: stop.id, type: 'DRIVER_PROBLEM', reason: DRIVER_PROBLEMS[body.kind], payloadJson: JSON.stringify(payload), createdAt: now } });
      await tx.notification.create({ data: { dedupKey: `driver-problem:${stop.id}:${now.toISOString()}`, vehicleId: session.vehicleId, stopId: stop.id, type: 'DRIVER_PROBLEM',
        message: `Водитель LKW ${stop.tour.vehicle.vehicleNumber} сообщает о проблеме на точке ${place}: ${DRIVER_PROBLEMS[body.kind]}${body.note ? ` — «${body.note}»` : ''}. Свяжитесь с водителем.`,
        payloadJson: JSON.stringify(payload) } });
      await writeAuditLog(tx, driverActor(session), { action: 'DRIVER_PROBLEM_REPORTED', entityType: 'Stop', entityId: stop.id, vehicleId: session.vehicleId, tourId: stop.tourId, stopId: stop.id, metadata: payload, createdAt: now });
    });
    return { ok: true };
  });
}
