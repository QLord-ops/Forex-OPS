import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AssistantError, type DispatcherAction, type DispatcherDependencies } from './dispatcher-assistant.js';
import { TourService } from './tours.js';
import { OperationsService } from './operations.js';
import { AppointmentService } from './appointments.js';
import { ReplanningService } from './replanning.js';
import { VehicleService } from './vehicles.js';
import type { RoutingProvider } from './routing.js';

const id = z.string().trim().min(1).max(200);
const date = z.string().datetime();
const reason = z.string().trim().min(3).max(2000);
const empty = z.object({}).strict();
const vehicleSchema = z.object({ vehicleNumber: id, licensePlate: z.string().trim().max(100).optional(), maxSpeedKmh: z.number().int().positive().max(85).default(85) }).strict();
const stopFields = {
  type: z.enum(['LOAD', 'UNLOAD']), address: z.string().trim().min(1).max(1000),
  company: z.string().max(500).optional(), city: z.string().max(200).nullable().optional(),
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
  appointmentAt: date.nullable().optional(), appointmentWindowStartAt: date.nullable().optional(), appointmentWindowEndAt: date.nullable().optional(),
  loadingMeters: z.number().min(0).max(100).nullable().optional(), referenceNumbers: z.array(z.string().trim().min(1).max(200)).max(20).nullable().optional(),
  instructions: z.string().max(4000).nullable().optional(), serviceMinMinutes: z.number().int().min(0).max(10080).default(60), serviceMaxMinutes: z.number().int().min(0).max(10080).default(120)
};
const stopSchema = z.object({ ...stopFields, sequence: z.number().int().positive().optional() }).strict();
const tourSchema = z.object({ orderNumber: id, trailerPlate: z.string().max(100).nullable().optional(), tourRemarks: z.string().max(4000).nullable().optional(), stops: z.array(stopSchema).min(2).max(100) }).strict();
const replanSchema = z.object({ tourId: id, futureStops: z.array(z.object({ ...stopFields, id: id.optional() }).strict()).min(1).max(100), origin: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).strict().optional() }).strict();
const clockSchema = z.object({ cycleStartedAt: date, dailyDrivingMinutes: z.number().int().min(0).max(600), drivingSinceBreakMinutes: z.number().int().min(0).max(240), extendedDrivingUsed: z.number().int().min(0).max(2), reducedRestUsed: z.number().int().min(0).max(3), currentExtendedDriving: z.boolean().optional(), currentReducedRest: z.boolean().optional(), reason }).strict().refine(v => v.drivingSinceBreakMinutes <= v.dailyDrivingMinutes, 'Непрерывная езда превышает суточную.');
const profileSchema = z.object({ heightMeters: z.number().positive().max(10).optional(), widthMeters: z.number().positive().max(10).optional(), lengthMeters: z.number().positive().max(50).optional(), weightKg: z.number().positive().max(200000).optional(), axleWeightKg: z.number().positive().max(50000).optional() }).strict().refine(v => Object.keys(v).length > 0, 'Укажите параметры машины.');

/** Reuse service transaction boundaries without opening nested transactions. */
export function transactionFacade(tx: Prisma.TransactionClient): PrismaClient {
  return new Proxy(tx, { get(target, key) {
    if (key === '$transaction') return (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => callback(tx);
    return Reflect.get(target, key);
  } }) as PrismaClient;
}

type RoutingSnapshot = Array<{ key: string; value?: unknown; failed?: boolean }>;
function routingKey(method: string, args: unknown[]) {
  // Confirmation is a few seconds later; retain the explicitly previewed traffic snapshot.
  return JSON.stringify([method, args], (key, value: unknown) => key === 'departureTime' ? undefined : value);
}
export function snapshotRouting(provider: RoutingProvider | null, entries: RoutingSnapshot): RoutingProvider {
  async function call(method: keyof RoutingProvider, args: unknown[]) {
    const key = routingKey(method, args);
    const saved = entries.find(entry => entry.key === key);
    if (saved) {
      if (saved.failed) throw new AssistantError('Данные маршрута недоступны.');
      return structuredClone(saved.value);
    }
    if (!provider) throw new AssistantError('Расчёт маршрута устарел. Выполните новый предпросмотр.', 409);
    try {
      const value = await (provider[method] as (...input: unknown[]) => Promise<unknown>).apply(provider, args);
      entries.push({ key, value: structuredClone(value) });
      return value;
    } catch (error) { entries.push({ key, failed: true }); throw error; }
  }
  return {
    geocode: address => call('geocode', [address]) as ReturnType<RoutingProvider['geocode']>,
    calculateRoute: (from, to, options) => call('calculateRoute', [from, to, options]) as ReturnType<RoutingProvider['calculateRoute']>,
    calculateMultiStopRoute: (stops, options) => call('calculateMultiStopRoute', [stops, options]) as ReturnType<RoutingProvider['calculateMultiStopRoute']>
  };
}
function validateStops(stops: Array<z.infer<typeof stopSchema>>) {
  for (const s of stops) {
    if (s.serviceMaxMinutes < s.serviceMinMinutes) throw new AssistantError('Максимальная стоянка меньше минимальной.');
    if ((s.latitude === undefined) !== (s.longitude === undefined)) throw new AssistantError('Нужны обе координаты.');
    if (Boolean(s.appointmentWindowStartAt) !== Boolean(s.appointmentWindowEndAt) || (s.appointmentWindowStartAt && s.appointmentWindowEndAt && s.appointmentWindowStartAt > s.appointmentWindowEndAt)) throw new AssistantError('Некорректное временное окно.');
    if (s.appointmentAt && s.appointmentWindowStartAt) throw new AssistantError('Выберите точный термин или временное окно.');
  }
}
async function ownedStop(db: PrismaClient, stopId: string, vehicleId: string) {
  const stop = await db.stop.findUnique({ where: { id: stopId }, include: { tour: true } });
  if (!stop || stop.tour.vehicleId !== vehicleId) throw new AssistantError('Точка не принадлежит выбранной машине.', 400);
  return stop;
}
async function ownedTour(db: PrismaClient, tourId: string, vehicleId: string) {
  const tour = await db.tour.findUnique({ where: { id: tourId } });
  if (!tour || tour.vehicleId !== vehicleId) throw new AssistantError('Тур не принадлежит выбранной машине.', 400);
  return tour;
}

export function createDispatcherDependencies(db: PrismaClient, routing: RoutingProvider, scenario?: DispatcherDependencies['scenario']): DispatcherDependencies {
  function services(client: PrismaClient, routes = routing) {
    const tours = new TourService(client, routes);
    return { tours, operations: new OperationsService(client, tours), appointments: new AppointmentService(client, undefined, (v, n) => tours.getCurrentPosition(v, n)), replanning: new ReplanningService(client, routes, (v, n) => tours.getCurrentPosition(v, n)) };
  }
  return {
    scenario,
    async prepare(action, input, vehicleId, now) {
      if (action === 'CREATE_VEHICLE') {
        const data = vehicleSchema.parse(input);
        return { input: data, preview: data };
      }
      if (!vehicleId) throw new AssistantError('Выберите машину.');
      const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
      const s = services(db);
      if (action === 'INFO') {
        empty.parse(input);
        return { preview: { vehicle, operations: await s.operations.get(vehicleId, now), position: await s.tours.getCurrentPosition(vehicleId, now) } };
      }
      if (action === 'CREATE_TOUR' || action === 'LOADED' || action === 'UNLOADED') {
        const entries: RoutingSnapshot = [];
        // Existing services perform network preparation before invoking $transaction.
        // Stopping at that boundary proves preview cannot create operational records.
        const dryDb = new Proxy(db, { get(target, key) { return key === '$transaction' ? async () => null : Reflect.get(target, key); } });
        const dry = services(dryDb, snapshotRouting(routing, entries));
        let data: Record<string, unknown>;
        if (action === 'CREATE_TOUR') {
          const parsed = tourSchema.parse(input); validateStops(parsed.stops);
          const stops = parsed.stops.map((stop, index) => ({ ...stop, sequence: stop.sequence ?? index + 1 }));
          data = { ...parsed, stops };
          await dry.tours.createTour({ ...parsed, stops, vehicleId });
        } else {
          data = z.object({ stopId: id, note: z.string().max(4000).optional() }).strict().parse(input);
          const stop = await ownedStop(db, String(data.stopId), vehicleId);
          if (stop.type !== (action === 'LOADED' ? 'LOAD' : 'UNLOAD')) throw new AssistantError('Действие не соответствует типу точки.');
          await dry.tours[action === 'LOADED' ? 'recordLoaded' : 'recordUnloaded'](String(data.stopId), now, data.note as string | undefined);
        }
        return { input: { data, routingSnapshot: entries }, preview: { ...data, routes: entries.filter(e => e.key.includes('calculateRoute')).map(e => e.value), trafficCheckedAt: now.toISOString() } };
      }
      if (action === 'REPLAN') {
        const data = replanSchema.parse(input); validateStops(data.futureStops);
        const tour = await ownedTour(db, data.tourId, vehicleId);
        const preview = await s.replanning.preview(tour.id, { ...data, version: tour.planVersion }, now);
        return { input: { tourId: tour.id, previewId: preview.id, version: preview.version }, preview };
      }
      if (action === 'APPOINTMENT') {
        const data = z.object({ stopId: id, appointmentAt: date }).strict().parse(input);
        await ownedStop(db, data.stopId, vehicleId);
        const preview = await s.appointments.preview(data.stopId, data, now);
        return { input: { ...data, version: preview.version }, preview };
      }
      if (action === 'ARRIVAL') {
        const data = z.object({ stopId: id, arrivedAt: date.optional() }).strict().parse(input);
        const stop = await ownedStop(db, data.stopId, vehicleId);
        if (stop.completedAt || stop.tour.status !== 'ACTIVE') throw new AssistantError('Точка не активна.');
        const arrivedAt = data.arrivedAt ?? now.toISOString();
        if (new Date(arrivedAt) > now) throw new AssistantError('Прибытие не может быть в будущем.');
        return { input: { ...data, arrivedAt }, preview: { stop, arrivedAt } };
      }
      let data: Record<string, unknown>;
      if (action === 'SET_CLOCK') data = clockSchema.parse(input);
      else if (action === 'WEEKLY_REST') data = z.object({ reason }).strict().parse(input);
      else if (action === 'EXCEPTION') {
        data = z.object({ kind: z.enum(['EXTENDED_DRIVING', 'REDUCED_REST', 'BOTH']) }).strict().parse(input);
        const operations = await s.operations.get(vehicleId, now);
        return { input: { ...data, version: vehicle.operationVersion }, preview: { ...data, operations } };
      } else if (action === 'PROFILE') {
        data = profileSchema.parse(input);
        const current = vehicle.truckProfile ? profileSchema.parse(JSON.parse(vehicle.truckProfile)) : {};
        data = { ...current, ...data };
      } else if (action === 'STOP' || action === 'RESUME') {
        data = empty.parse(input);
        if (action === 'RESUME' && await db.vehicleIssue.findFirst({ where: { vehicleId, kind: 'BREAKDOWN', resolvedAt: null } })) throw new AssistantError('Сначала подтвердите ремонт машины.');
      } else throw new AssistantError(`Действие ${action} не поддерживается адаптером.`);
      return { input: { ...data, version: vehicle.operationVersion }, preview: { vehicleNumber: vehicle.vehicleNumber, action, ...data } };
    },
    async execute(action, input, vehicleId, tx, now) {
      const client = transactionFacade(tx);
      // No execution path receives a live network provider.
      const routes = snapshotRouting(null, (input.routingSnapshot ?? []) as RoutingSnapshot);
      const s = services(client, routes);
      if (action === 'CREATE_VEHICLE') return new VehicleService(client).create(vehicleSchema.parse(input));
      if (!vehicleId) throw new AssistantError('Выберите машину.');
      if (action === 'CREATE_TOUR') {
        const data = tourSchema.parse(input.data); validateStops(data.stops);
        return s.tours.createTour({ ...data, vehicleId, stops: data.stops.map((stop, index) => ({ ...stop, sequence: stop.sequence ?? index + 1 })) });
      }
      if (action === 'LOADED' || action === 'UNLOADED') {
        const data = z.object({ stopId: id, note: z.string().optional() }).parse(input.data);
        const stop = await ownedStop(client, data.stopId, vehicleId);
        if (stop.type !== (action === 'LOADED' ? 'LOAD' : 'UNLOAD')) throw new AssistantError('Неверный тип точки.');
        return s.tours[action === 'LOADED' ? 'recordLoaded' : 'recordUnloaded'](data.stopId, now, data.note);
      }
      if (action === 'REPLAN') { await ownedTour(client, String(input.tourId), vehicleId); return s.replanning.apply(String(input.tourId), { previewId: String(input.previewId), version: z.number().int().parse(input.version) }, now); }
      if (action === 'APPOINTMENT') { await ownedStop(client, String(input.stopId), vehicleId); return s.appointments.apply(String(input.stopId), { appointmentAt: date.parse(input.appointmentAt), version: z.number().int().parse(input.version) }, now); }
      if (action === 'ARRIVAL') { await ownedStop(client, String(input.stopId), vehicleId); return s.operations.confirmArrival(String(input.stopId), new Date(date.parse(input.arrivedAt)), now); }
      const vehicle = await client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
      if (action === 'BREAKDOWN') {
        if (vehicle.manualStoppedAt) return { stopped: true };
        const context = await s.operations.context(vehicleId, now);
        if (context.activeLeg && !context.currentStop?.arrivedAt) return s.operations.manualStop(vehicleId, vehicle.operationVersion, now);
        await client.vehicle.update({ where: { id: vehicleId }, data: { manualStoppedAt: now } });
        return { stopped: true };
      }
      const { version: rawVersion, ...data } = input;
      const version = z.number().int().nonnegative().parse(rawVersion);
      if (action === 'SET_CLOCK') return s.operations.setClock(vehicleId, { ...clockSchema.parse(data), version }, now);
      if (action === 'WEEKLY_REST') return s.operations.weeklyRest(vehicleId, version, reason.parse(data.reason), now);
      if (action === 'EXCEPTION') return s.operations.acceptException(vehicleId, version, z.enum(['EXTENDED_DRIVING', 'REDUCED_REST', 'BOTH']).parse(data.kind), now);
      if (action === 'STOP') return s.operations.manualStop(vehicleId, version, now);
      if (action === 'RESUME') {
        if (await client.vehicleIssue.findFirst({ where: { vehicleId, kind: 'BREAKDOWN', resolvedAt: null } })) throw new AssistantError('Сначала подтвердите ремонт машины.');
        return s.operations.resume(vehicleId, version, now);
      }
      if (action === 'PROFILE') {
        const profile = profileSchema.parse(data);
        const changed = await client.vehicle.updateMany({ where: { id: vehicleId, operationVersion: version }, data: { truckProfile: JSON.stringify(profile), operationVersion: { increment: 1 } } });
        if (!changed.count) throw new AssistantError('Параметры машины изменились.', 409);
        return profile;
      }
      throw new AssistantError(`Действие ${action as DispatcherAction} не поддерживается.`);
    }
  };
}
