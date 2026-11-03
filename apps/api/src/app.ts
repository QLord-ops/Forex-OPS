import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { CALCULATED_POSITION_DISCLAIMER, type CurrentPosition, withoutPositionGeometry } from "./domain.js";
import { prisma } from "./lib/prisma.js";
import { AlertService } from "./services/alerts.js";
import { AppointmentService } from "./services/appointments.js";
import { EtaService } from "./services/eta.js";
import { importExcelPreview } from "./services/excel-order-import.js";
import {
  importImagePreview,
  importPdfPreview,
  isSupportedImageMimeType,
  type ImageImportPreview,
  type PdfImportPreview
} from "./services/pdf-order-import.js";
import { OsrmRoutingProvider, RoutingError, RoutingService } from "./services/routing.js";
import { geocodePrecisions, resolveAddressWithFallback } from "./services/address-resolution.js";
import { BudgetedAddressResearcher } from "./services/address-research.js";
import { validateXlsxArchive } from "./services/xlsx-validation.js";
import { enrichTour, snapshotVehicleClock, type TourAggregate, toDashboardTourSummary, toIsoObject, tourInclude, TourService } from "./services/tours.js";
import { VehicleService } from "./services/vehicles.js";
import { calculateDwellState, NotificationService } from "./services/notifications.js";
import { OperationsService, SYSTEM_WEBFLEET_ACTOR } from "./services/operations.js";
import { ReplanningService } from "./services/replanning.js";
import { PrismaTrafficQuotaStore, TomTomRoutingProvider, TrafficRoutingService } from './services/traffic-routing.js';
import { TrafficOperationsService } from './services/traffic-operations.js';
import { VEHICLE_CLOCK_LIMITS } from './services/vehicle-clock.js';
import { bindWebfleetObject, listWebfleetBindings, unbindWebfleetVehicle, WebfleetSyncService, WebfleetTelemetryService, type AutoArrivalHandler } from './services/webfleet.js';
import { buildVehicleCard, suggestWebfleetBindings, vehicleObjectUid, WebfleetDetailsSync, WebfleetLiveStore, WebfleetTrackService } from './services/webfleet-live.js';
import { calculateRiskColor, calculateSimulatedDuration } from './services/simulation.js';
import { forecastDrive } from './services/vehicle-clock.js';
import { parseClockState } from './services/tours.js';
import { registerDispatcherAuth, requireDispatcherRoles, type DispatcherAuthOptions } from './services/dispatcher-auth.js';
import { RouteScenarioService, routeScenarioInputSchema } from './services/route-scenario.js';
import { registerRouteScenarioRoutes } from './routes/route-scenario.js';
import { AssistantError, DispatcherAssistantService } from './services/dispatcher-assistant.js';
import { assistantSessionKey, registerDispatcherAssistantRoutes } from './routes/dispatcher-assistant.js';
import { registerDispatcherRoutes } from './routes/dispatchers.js';
import { registerVehicleAssignmentRoutes } from './routes/vehicle-assignment.js';
import { createDispatcherDependencies } from './services/dispatcher-adapters.js';
import { writeAuditLog, type AuditActor } from './services/audit-log.js';

function auditActor(request: FastifyRequest): AuditActor | undefined {
  return request.dispatcherSession
    ? { role: request.dispatcherSession.role, sessionId: request.dispatcherSession.sessionId, dispatcherId: request.dispatcherSession.dispatcherId }
    : undefined;
}

/** Records who changed what after a mutating route succeeded (CLAUDE.md rule 7). */
async function audit(request: FastifyRequest, action: string, entityType: string, entityId: string,
  extra: { vehicleId?: string | null; tourId?: string | null; stopId?: string | null; metadata?: Record<string, unknown> } = {}) {
  await writeAuditLog(prisma, auditActor(request), { action, entityType, entityId, ...extra });
}

const trafficQuota = new PrismaTrafficQuotaStore(prisma);
const trafficProvider = new TomTomRoutingProvider(trafficQuota, new OsrmRoutingProvider());
const routingService = new RoutingService(trafficProvider);
const addressResearcher = new BudgetedAddressResearcher(prisma);
const tourService = new TourService(prisma, routingService);
const etaService = new EtaService();
const alertService = new AlertService(prisma);
const vehicleService = new VehicleService(prisma);
const notificationService = new NotificationService(prisma, tourService);
const operationsService = new OperationsService(prisma, tourService);
// Automatic arrival from fresh Webfleet GPS (zone + standstill); AUTO_ARRIVAL_ENABLED=false keeps it a suggestion.
const autoArrival: AutoArrivalHandler | undefined = process.env.AUTO_ARRIVAL_ENABLED === 'false' ? undefined
  : (input) => operationsService.confirmArrival(input.stopId, input.arrivedAt, input.now, SYSTEM_WEBFLEET_ACTOR, { source: 'WEBFLEET_AUTO', meta: input.meta });
const webfleetLive = new WebfleetLiveStore();
const webfleetSync = new WebfleetSyncService(prisma, undefined, undefined, autoArrival, (positions, now) => webfleetLive.setObjects(positions, now));
const webfleetDetails = new WebfleetDetailsSync(webfleetLive);
const webfleetTracks = new WebfleetTrackService();
const webfleetTelemetry = new WebfleetTelemetryService(prisma, autoArrival);
const currentPosition = async (id: string, now = new Date()) => {
  return withWebfleetPosition(await tourService.getCurrentPosition(id, now), await webfleetTelemetry.latest(id, now));
};
const appointmentService = new AppointmentService(prisma, etaService, currentPosition);
const replanningService = new ReplanningService(prisma, routingService, currentPosition);
const trafficService = new TrafficOperationsService(prisma, tourService, notificationService, new TrafficRoutingService(trafficProvider, trafficQuota), currentPosition);
const scenarioService = new RouteScenarioService(prisma, routingService, currentPosition);
const assistantService = new DispatcherAssistantService(prisma, createDispatcherDependencies(prisma, routingService,
  (input, vehicleId, now) => scenarioService.calculate(routeScenarioInputSchema.parse({ ...input, vehicleId }), now)));

const vehicleSchema = z.object({
  vehicleNumber: z.string().trim().min(1),
  licensePlate: z.string().trim().optional(),
  maxSpeedKmh: z.number().int().positive().max(85).default(85)
});

const stopSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  sequence: z.number().int().positive(),
  type: z.enum(["LOAD", "UNLOAD"]),
  company: z.string().optional(),
  address: z.string().trim().min(1),
  sourceAddress: z.string().trim().max(2000).nullable().optional(),
  resolvedAddress: z.string().trim().max(2000).nullable().optional(),
  geocodePrecision: z.enum(geocodePrecisions).nullable().optional(),
  geocodeProvider: z.string().trim().max(100).nullable().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  city: z.string().trim().max(200).nullable().optional(),
  appointmentWindowStartAt: z.string().datetime().nullable().optional(),
  appointmentWindowEndAt: z.string().datetime().nullable().optional(),
  loadingMeters: z.number().min(0).max(100).nullable().optional(),
  referenceNumbers: z.array(z.string().trim().min(1).max(200)).max(20).nullable().optional(),
  instructions: z.string().trim().max(4000).nullable().optional(),
  serviceMinMinutes: z.number().int().min(0).max(10080).default(60),
  serviceMaxMinutes: z.number().int().min(0).max(10080).default(120),
  appointmentAt: z.string().datetime().nullable().optional()
}).superRefine((stop, context) => {
  if (stop.serviceMaxMinutes < stop.serviceMinMinutes) context.addIssue({ code: "custom", message: "Максимальное время стоянки не может быть меньше минимального." });
  if (Boolean(stop.appointmentWindowStartAt) !== Boolean(stop.appointmentWindowEndAt)) context.addIssue({ code: "custom", message: "Для временного окна нужны начало и конец." });
  if (stop.appointmentWindowStartAt && stop.appointmentWindowEndAt && stop.appointmentWindowStartAt > stop.appointmentWindowEndAt) context.addIssue({ code: "custom", message: "Конец временного окна раньше начала." });
  if (stop.appointmentAt && (stop.appointmentWindowStartAt || stop.appointmentWindowEndAt)) context.addIssue({ code: "custom", message: "Точный термин и временное окно задаются отдельно." });
});

const createTourSchema = z.object({
  vehicleId: z.string().min(1),
  orderNumber: z.string().trim().min(1),
  trailerPlate: z.string().trim().max(100).nullable().optional(),
  tourRemarks: z.string().trim().max(4000).nullable().optional(),
  stops: z.array(stopSchema).min(2)
});

const confirmImportedTourSchema = createTourSchema.extend({
  importAttemptId: z.string().trim().min(8).max(200),
  importFingerprint: z.string().trim().min(8).max(200)
});

const patchTourSchema = z.union([
  z.object({ status: z.literal("CANCELLED") }),
  createTourSchema.extend({ version: z.number().int().nonnegative().optional() })
]);

export interface BuildAppOptions {
  auth?: DispatcherAuthOptions;
  pdfImport?: (buffer: Buffer, filename: string) => Promise<PdfImportPreview>;
  imageImport?: (buffer: Buffer, filename: string, mimeType: "image/png" | "image/jpeg" | "image/webp") => Promise<ImageImportPreview>;
  databaseCheck?: () => Promise<unknown>;
}

/** Number of proxies in front of the API; 0 means use the socket address. */
export function trustedProxyHops(value = process.env.TRUST_PROXY_HOPS, production = process.env.NODE_ENV === 'production'): number | false {
  if (value !== undefined && /^\d+$/.test(value.trim())) return Number(value.trim()) || false;
  return production ? 2 : false;
}

export function proxyTrust(hops: number | false) {
  return hops ? (_address: string, hop: number) => hop < hops : false;
}

export const HISTORY_LIMITS = { tours: 300, events: 2000 } as const;
const DASHBOARD_CONCURRENCY = 4;

/** Runs `work` for every item with at most `limit` in flight, keeping the input order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// TomTom calls on behalf of a dispatcher: generous for real work, too low to burn the monthly quota.
const routingRateLimit = { max: 20, timeWindow: '1 minute' };

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    // Browser → Vercel rewrite → DigitalOcean edge → app: without this every user shares one proxy IP.
    trustProxy: proxyTrust(trustedProxyHops()),
    logger: {
      redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'], censor: '[скрыто]' },
      serializers: { req: (request: { method: string; url: string; ip?: string }) => ({ method: request.method, url: request.url.split('?')[0] }) }
    }
  });
  const isServerless = Boolean(process.env.VERCEL);
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? process.env.DISPATCHER_ALLOWED_ORIGINS ?? 'https://ops-disponent-web.vercel.app,http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(value => value.trim()).filter(Boolean);
  const allowedOriginSet = new Set(allowedOrigins);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || allowedOriginSet.has(origin)),
    credentials: true
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' }
  });
  registerDispatcherAuth(app, prisma, options.auth?.origins ? options.auth : { ...options.auth, origins: allowedOrigins });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: request => request.dispatcherSession?.sessionId ?? request.ip
  });
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 1,
      parts: 2,
      fileSize: 20 * 1024 * 1024
    }
  });
  registerDispatcherAssistantRoutes(app, assistantService);
  registerDispatcherRoutes(app, prisma);
  registerVehicleAssignmentRoutes(app, prisma);
  await registerRouteScenarioRoutes(app, { service: scenarioService });

  let activeOrderImports = 0;
  const pdfImport = options.pdfImport ?? importPdfPreview;
  const imageImport = options.imageImport ?? importImagePreview;
  const databaseCheck = options.databaseCheck ?? (() => prisma.$queryRaw`SELECT 1`);
  const subscribers = new Set<import('node:http').ServerResponse>();
  const subscriberSessions = new Map<string, number>();
  const maxSseConnectionsPerSession = Math.max(1, Number.parseInt(process.env.SSE_MAX_CONNECTIONS_PER_SESSION ?? '3', 10) || 3);
  let notificationTimer: ReturnType<typeof setInterval> | undefined;
  let refreshingNotifications = false;
  let lastNotificationRefreshAt = 0;
  const operationsRefreshStateId = 'SYSTEM:OPERATIONS_REFRESH';
  const acquireOperationsRefreshLease = async () => {
    if (!isServerless) return true;
    const now = new Date();
    await prisma.integrationSyncState.upsert({
      where: { id: operationsRefreshStateId },
      create: { id: operationsRefreshStateId, provider: 'SYSTEM' },
      update: {}
    });
    const locked = await prisma.integrationSyncState.updateMany({
      where: {
        id: operationsRefreshStateId,
        AND: [
          { OR: [{ lastSnapshotAt: null }, { lastSnapshotAt: { lt: new Date(now.getTime() - 25_000) } }] },
          { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }
        ]
      },
      data: { lockedUntil: new Date(now.getTime() + 60_000) }
    });
    return locked.count === 1;
  };
  const refreshNotifications = async () => {
    if (refreshingNotifications) return;
    if (!await acquireOperationsRefreshLease()) return;
    refreshingNotifications = true;
    try {
      await webfleetSync.refreshIfDue().catch(() => undefined);
      await webfleetDetails.refreshIfDue().catch(() => undefined);
      await notificationService.refresh();
      await refreshAllAlerts();
      await trafficService.tick();
      lastNotificationRefreshAt = Date.now();
      for (const client of subscribers) client.write(`event: operations\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    } catch (error) { app.log.error(error); }
    finally {
      refreshingNotifications = false;
      if (isServerless) {
        await prisma.integrationSyncState.updateMany({
          where: { id: operationsRefreshStateId },
          data: { lastSnapshotAt: new Date(), lockedUntil: null }
        }).catch(() => undefined);
      }
    }
  };
  app.addHook('onListen', async () => {
    if (isServerless) return;
    await refreshNotifications();
    notificationTimer = setInterval(() => { void refreshNotifications(); }, 15_000);
    notificationTimer.unref();
  });
  app.addHook('onClose', async () => {
    if (notificationTimer) clearInterval(notificationTimer);
    for (const client of subscribers) client.end();
    subscribers.clear();
    subscriberSessions.clear();
  });

  app.get('/notifications', async (request) => {
    if (isServerless && Date.now() - lastNotificationRefreshAt >= 25_000) await refreshNotifications();
    const notifications = await notificationService.list();
    // Pop-ups follow the dispatcher's own and free trucks; the alerts page still lists everything.
    const me = request.dispatcherSession?.dispatcherId;
    if (!me) return { notifications };
    const others = new Set((await prisma.vehicle.findMany({ where: { assignedDispatcherId: { not: null, notIn: [me] } }, select: { id: true } })).map((vehicle) => vehicle.id));
    return { notifications: notifications.filter((notification) => !others.has(notification.vehicleId)) };
  });
  app.post('/notifications/:id/ack', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await notificationService.acknowledge(id);
    await audit(request, 'NOTIFICATION_ACKNOWLEDGED', 'Notification', id);
    return { ok: true };
  });
  app.get('/events/stream', async (request, reply) => {
    const sessionId = request.dispatcherSession?.sessionId;
    if (!sessionId) return reply.code(401).send({ error: 'Войдите в диспетчерскую.' });
    const activeConnections = subscriberSessions.get(sessionId) ?? 0;
    if (activeConnections >= maxSseConnectionsPerSession) return reply.code(429).send({ error: 'Слишком много открытых подключений событий.' });
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // On reconnect clients reload durable unread notifications rather than relying on transient event IDs.
    reply.raw.write('retry: 3000\nevent: operations\ndata: {}\n\n');
    subscribers.add(reply.raw);
    subscriberSessions.set(sessionId, activeConnections + 1);
    let closed = false;
    request.raw.on('close', () => {
      if (closed) return;
      closed = true;
      subscribers.delete(reply.raw);
      const remaining = (subscriberSessions.get(sessionId) ?? 1) - 1;
      if (remaining > 0) subscriberSessions.set(sessionId, remaining);
      else subscriberSessions.delete(sessionId);
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (isPrismaRecordNotFound(error)) return reply.status(404).send({ error: "Запись не найдена." });
    const statusCode = error instanceof z.ZodError ? 400 : hasStatusCode(error) ? error.statusCode : 500;
    const message = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join(".") || "Eingabe"}: ${issue.message}`).join("; ")
      : error instanceof Error
        ? error.message
        : "Неизвестная ошибка";
    if (statusCode >= 500) app.log.error(error);
    reply.status(statusCode).send({
      error: statusCode >= 500 && !(error instanceof RoutingError) ? "Interner Serverfehler" : message
    });
  });

  app.get("/", async (_request, reply) => reply.redirect("https://ops-disponent-web.vercel.app/"));
  app.get("/health", async (_request, reply) => {
    const timestamp = new Date().toISOString();
    try {
      await databaseCheck();
      return { ok: true, service: "@ops/api", database: "ok", timestamp };
    } catch (error) {
      app.log.error({ errorType: error instanceof Error ? error.name : 'unknown' }, "База данных недоступна для /health");
      return reply.code(503).send({ ok: false, service: "@ops/api", database: "unavailable", timestamp });
    }
  });

  const idParams = z.object({ id: z.string().min(1) });
  const versionInput = z.object({ version: z.number().int().nonnegative() });
  app.get('/vehicles/:id/operations', async request => {
    const id = idParams.parse(request.params).id;
    return { ...await operationsService.get(id), traffic: await trafficService.status(id) };
  });
  app.put('/vehicles/:id/clock', async request => {
    const input = versionInput.extend({
      cycleStartedAt: z.string().datetime(), dailyDrivingMinutes: z.number().int().min(0).max(600),
      currentExtendedDriving: z.boolean().optional(), currentReducedRest: z.boolean().optional(),
      drivingSinceBreakMinutes: z.number().int().min(0).max(240),
      extendedDrivingUsed: z.number().int().min(0).max(2), reducedRestUsed: z.number().int().min(0).max(3),
      reason: z.string().trim().min(3).max(2000)
    }).refine(value => value.drivingSinceBreakMinutes <= value.dailyDrivingMinutes).parse(request.body);
    const id = idParams.parse(request.params).id;
    const result = await operationsService.setClock(id, input);
    await audit(request, 'VEHICLE_CLOCK_SET', 'Vehicle', id, { vehicleId: id, metadata: { reason: input.reason, cycleStartedAt: input.cycleStartedAt, dailyDrivingMinutes: input.dailyDrivingMinutes } });
    return result;
  });
  app.post('/vehicles/:id/manual-stop', async request => {
    const id = idParams.parse(request.params).id;
    const result = await operationsService.manualStop(id, versionInput.parse(request.body).version);
    await audit(request, 'VEHICLE_MANUAL_STOP', 'Vehicle', id, { vehicleId: id });
    return result;
  });
  app.post('/vehicles/:id/resume', async request => {
    const id = idParams.parse(request.params).id;
    const { version } = versionInput.parse(request.body);
    const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id } });
    if (vehicle.operationVersion !== version || !vehicle.manualStoppedAt) throw Object.assign(new Error('Состояние грузовика изменилось или он не остановлен.'), { statusCode: 409 });
    const refreshed = await trafficService.refresh(id, 'manual');
    const result = await operationsService.resume(id, refreshed.version);
    await audit(request, 'VEHICLE_RESUMED', 'Vehicle', id, { vehicleId: id });
    return result;
  });
  app.get('/vehicles/:id/traffic', async request => trafficService.status(idParams.parse(request.params).id));
  app.post('/vehicles/:id/traffic/refresh', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const id = idParams.parse(request.params).id;
    const result = await trafficService.refresh(id, 'manual');
    await audit(request, 'TRAFFIC_REFRESHED', 'Vehicle', id, { vehicleId: id });
    return result;
  });
  app.post('/vehicles/:id/traffic/accept', async request => {
    const input = versionInput.extend({ index: z.number().int().min(0).max(1), origin: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional() }).parse(request.body);
    const id = idParams.parse(request.params).id;
    const result = await trafficService.accept(id, input.index, input.version, input.origin);
    await audit(request, 'TRAFFIC_ROUTE_ACCEPTED', 'Vehicle', id, { vehicleId: id, metadata: { index: input.index } });
    return result;
  });
  app.post('/vehicles/:id/traffic/reject', async request => {
    const id = idParams.parse(request.params).id;
    const result = await trafficService.reject(id, versionInput.parse(request.body).version);
    await audit(request, 'TRAFFIC_ROUTE_REJECTED', 'Vehicle', id, { vehicleId: id });
    return result;
  });
  app.put('/vehicles/:id/truck-profile', async request => {
    const { version, ...profile } = versionInput.extend({
      heightMeters: z.number().positive().max(10), widthMeters: z.number().positive().max(10),
      lengthMeters: z.number().positive().max(50), weightKg: z.number().positive().max(200000), axleWeightKg: z.number().positive().max(50000)
    }).parse(request.body);
    const vehicleId = idParams.parse(request.params).id;
    await prisma.$transaction(async tx => {
      const changed = await tx.vehicle.updateMany({ where: { id: vehicleId, operationVersion: version }, data: { truckProfile: JSON.stringify(profile), operationVersion: { increment: 1 } } });
      if (!changed.count) throw Object.assign(new Error('Состояние грузовика изменилось.'), { statusCode: 409 });
      await tx.operationEvent.create({ data: { vehicleId, type: 'TRUCK_PROFILE_UPDATED', payloadJson: JSON.stringify(profile) } });
      await writeAuditLog(tx, auditActor(request), { action: 'TRUCK_PROFILE_UPDATED', entityType: 'Vehicle', entityId: vehicleId, vehicleId, metadata: profile });
    });
    return operationsService.get(vehicleId);
  });
  app.post('/vehicles/:id/weekly-rest', async request => {
    const input = versionInput.extend({ reason: z.string().trim().min(3).max(2000) }).parse(request.body);
    const id = idParams.parse(request.params).id;
    const result = await operationsService.weeklyRest(id, input.version, input.reason);
    await audit(request, 'WEEKLY_REST_CONFIRMED', 'Vehicle', id, { vehicleId: id, metadata: { reason: input.reason } });
    return result;
  });
  app.post('/vehicles/:id/exceptions', async request => {
    const input = versionInput.extend({ kind: z.enum(['EXTENDED_DRIVING', 'REDUCED_REST', 'BOTH']) }).parse(request.body);
    const id = idParams.parse(request.params).id;
    const result = await operationsService.acceptException(id, input.version, input.kind);
    await audit(request, 'DRIVING_EXCEPTION_ACCEPTED', 'Vehicle', id, { vehicleId: id, metadata: { kind: input.kind } });
    return result;
  });
  app.delete('/vehicles/:id/exceptions', async request => {
    const id = idParams.parse(request.params).id;
    const result = await operationsService.cancelExceptions(id, versionInput.parse(request.body).version);
    await audit(request, 'DRIVING_EXCEPTIONS_CANCELLED', 'Vehicle', id, { vehicleId: id });
    return result;
  });
  app.post('/stops/:id/arrival', async request => {
    const input = z.object({ arrivedAt: z.string().datetime().optional() }).parse(request.body ?? {});
    return operationsService.confirmArrival(idParams.parse(request.params).id, input.arrivedAt ? new Date(input.arrivedAt) : new Date(), new Date(), auditActor(request));
  });
  app.post('/stops/:id/arrival/revert', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async request => {
    const input = z.object({ reason: z.string().trim().max(300).optional() }).parse(request.body ?? {});
    const { id } = idParams.parse(request.params);
    const result = await operationsService.revertArrival(id, new Date(), auditActor(request), input.reason || undefined);
    const stop = await prisma.stop.findUniqueOrThrow({ where: { id }, select: { tour: { select: { vehicleId: true } } } });
    await refreshAlertsForVehicle(stop.tour.vehicleId);
    return result;
  });
  app.put('/stops/:id/arrival-radius', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async request => {
    const input = z.object({ radiusMeters: z.number().int().min(100).max(5000).nullable() }).parse(request.body ?? {});
    return operationsService.setArrivalRadius(idParams.parse(request.params).id, input.radiusMeters, new Date(), auditActor(request));
  });
  app.post('/stops/:id/not-arrived', async request => {
    const input = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).parse(request.body);
    const stop = await prisma.stop.findUniqueOrThrow({ where: { id: idParams.parse(request.params).id }, include: { tour: { include: { stops: { orderBy: { sequence: 'asc' } } } } } });
    if (stop.arrivedAt || stop.completedAt || stop.tour.stops.find(item => !item.completedAt)?.id !== stop.id) throw Object.assign(new Error('Требуется текущая неподтверждённая точка.'), { statusCode: 409 });
    const preview = await replanningService.preview(stop.tourId, { version: stop.tour.planVersion, origin: input,
      futureStops: stop.tour.stops.filter(item => !item.completedAt).map(item => ({ ...item, type: item.type as 'LOAD' | 'UNLOAD', appointmentAt: item.appointmentAt?.toISOString() ?? null })) });
    await replanningService.apply(stop.tourId, { previewId: preview.id, version: preview.version }, new Date(), auditActor(request));
    await prisma.notification.updateMany({ where: { stopId: stop.id, type: 'PREDICTED_ARRIVAL', acknowledgedAt: null }, data: { acknowledgedAt: new Date() } });
    return { ok: true };
  });
  app.post('/stops/:id/appointment/preview', async request => {
    const stopId = idParams.parse(request.params).id;
    const input = z.object({ appointmentAt: z.string().datetime() }).parse(request.body);
    return appointmentService.preview(stopId, input);
  });
  app.put('/stops/:id/appointment', async request => {
    const stopId = idParams.parse(request.params).id;
    const input = versionInput.extend({ appointmentAt: z.string().datetime() }).parse(request.body);
    const analysis = await appointmentService.apply(stopId, input);
    await audit(request, 'STOP_APPOINTMENT_SET', 'Stop', stopId, { vehicleId: analysis.vehicleId, stopId, metadata: { appointmentAt: input.appointmentAt } });
    await refreshAlertsForVehicle(analysis.vehicleId);
    return analysis;
  });
  app.post('/tours/:id/replan/preview', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async request => {
    const input = versionInput.extend({
      futureStops: z.array(z.object({
        id: z.string().optional(), type: z.enum(['LOAD', 'UNLOAD']), address: z.string().trim().min(1),
        company: z.string().optional(), city: z.string().nullable().optional(), appointmentAt: z.string().datetime().nullable().optional(),
        latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
        serviceMinMinutes: z.number().int().min(0).max(10080).optional(), serviceMaxMinutes: z.number().int().min(0).max(10080).optional()
      })).min(1).max(100),
      origin: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional()
    }).parse(request.body);
    return replanningService.preview(idParams.parse(request.params).id, input);
  });
  app.post('/tours/:id/replan/apply', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async request => {
    const input = versionInput.extend({ previewId: z.string().min(1) }).parse(request.body);
    return replanningService.apply(idParams.parse(request.params).id, input, new Date(), auditActor(request));
  });

  app.post("/imports/excel/preview", { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: "Файл Excel необходимо отправить как multipart/form-data в поле 'file'." });
    }
    if (activeOrderImports >= 2) {
      return reply.status(429).send({ error: "Слишком много одновременных импортов Excel. Повторите попытку позже." });
    }

    activeOrderImports += 1;
    try {
      const file = await request.file({ limits: { fileSize: 5 * 1024 * 1024 } });
      if (!file) return reply.status(400).send({ error: "Excel-Datei fehlt." });

      const filename = file.filename.trim();
      const allowedMimeTypes = new Set([
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/octet-stream",
        "application/zip"
      ]);
      if (file.fieldname !== "file" || !filename.toLowerCase().endsWith(".xlsx") || !allowedMimeTypes.has(file.mimetype)) {
        file.file.resume();
        return reply.status(415).send({ error: "В поле 'file' поддерживаются только файлы Excel формата .xlsx." });
      }

      const buffer = await file.toBuffer();
      if (buffer.length > 5 * 1024 * 1024) {
        return reply.status(413).send({ error: "Размер файла Excel не должен превышать 5 МБ." });
      }
      if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
        return reply.status(415).send({ error: "Файл не является корректной книгой .xlsx." });
      }

      try {
        validateXlsxArchive(buffer);
      } catch (error) {
        request.log.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, "Отклонена небезопасная или повреждённая книга Excel");
        return reply.status(422).send({ error: "Не удалось безопасно прочитать книгу Excel." });
      }
      let result;
      try {
        result = await importExcelPreview(buffer, filename, {
          beforeAi: options.auth?.disabled ? undefined : () => assistantService.consumeUsage(assistantSessionKey(request))
        });
      } catch (error) {
        if (error instanceof AssistantError) throw error;
        request.log.error({ errorType: error instanceof Error ? error.name : 'unknown' }, "Не удалось разобрать книгу Excel");
        return reply.status(422).send({ error: "Не удалось безопасно прочитать книгу Excel." });
      }
      return {
        source: result.source,
        detectedLayout: result.detectedLayout,
        drafts: result.drafts.map((draft) => ({
          orderNumber: draft.orderNumber,
          vehicleNumber: draft.vehicleNumber,
          stops: draft.stops,
          warnings: draft.warnings.map((warning) => ({
            code: warning.code,
            message: warning.message,
            row: warning.sourceRow
          }))
        })),
        warnings: result.warnings.map((warning) => ({
          code: warning.code,
          message: warning.message,
          row: warning.sourceRow
        })),
        aiAvailable: result.aiAvailable
      };
    } finally {
      activeOrderImports -= 1;
    }
  });

  app.post("/imports/pdf/preview", { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: "PDF-заказ необходимо отправить как multipart/form-data в поле 'file'." });
    }
    if (activeOrderImports >= 2) {
      return reply.status(429).send({ error: "Слишком много одновременных импортов заказов. Повторите попытку позже." });
    }

    activeOrderImports += 1;
    try {
      const file = await request.file({ limits: { fileSize: 20 * 1024 * 1024 } });
      if (!file) return reply.status(400).send({ error: "PDF-заказ не приложен." });

      const filename = file.filename.trim();
      const allowedMimeTypes = new Set(["application/pdf", "application/octet-stream", "application/x-pdf"]);
      if (file.fieldname !== "file" || !filename.toLocaleLowerCase().endsWith(".pdf") || !allowedMimeTypes.has(file.mimetype)) {
        file.file.resume();
        return reply.status(415).send({ error: "В поле 'file' поддерживаются только PDF-заказы формата .pdf." });
      }

      const buffer = await file.toBuffer();
      if (buffer.length > 20 * 1024 * 1024) {
        return reply.status(413).send({ error: "Размер PDF-заказа не должен превышать 20 МБ." });
      }
      if (!hasPdfHeader(buffer)) {
        return reply.status(415).send({ error: "Файл не является корректным PDF-заказом." });
      }

      if (!options.auth?.disabled) await assistantService.consumeUsage(assistantSessionKey(request));
      try {
        return await pdfImport(buffer, filename);
      } catch (error) {
        if (error instanceof Error && error.message.includes("OPENAI_API_KEY")) {
          return reply.status(503).send({ error: "OpenAI ещё не настроен для импорта PDF." });
        }
        request.log.error({ err: error }, "Не удалось распознать PDF-заказ");
        return reply.status(502).send({ error: "Не удалось прочитать PDF-заказ. Проверьте файл и повторите попытку." });
      }
    } finally {
      activeOrderImports -= 1;
    }
  });

  app.post("/imports/image/preview", { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: "Скриншот необходимо отправить как multipart/form-data в поле 'file'." });
    }
    if (activeOrderImports >= 2) {
      return reply.status(429).send({ error: "Слишком много одновременных импортов заказов. Повторите попытку позже." });
    }

    activeOrderImports += 1;
    try {
      const file = await request.file({ limits: { fileSize: 10 * 1024 * 1024 } });
      if (!file) return reply.status(400).send({ error: "Скриншот не приложен." });

      const filename = file.filename.trim();
      const lowerFilename = filename.toLocaleLowerCase();
      const extensionAllowed = [".png", ".jpg", ".jpeg", ".webp"].some((extension) => lowerFilename.endsWith(extension));
      if (file.fieldname !== "file" || !extensionAllowed || !isSupportedImageMimeType(file.mimetype)
        || !imageExtensionMatchesMimeType(lowerFilename, file.mimetype)) {
        file.file.resume();
        return reply.status(415).send({ error: "В поле 'file' поддерживаются только скриншоты PNG, JPG/JPEG или WebP." });
      }

      const buffer = await file.toBuffer();
      if (buffer.length > 10 * 1024 * 1024) {
        return reply.status(413).send({ error: "Размер скриншота не должен превышать 10 МБ." });
      }
      if (!hasImageHeader(buffer, file.mimetype)) {
        return reply.status(415).send({ error: "Файл не является корректным изображением PNG, JPG/JPEG или WebP." });
      }

      if (!options.auth?.disabled) await assistantService.consumeUsage(assistantSessionKey(request));
      try {
        return await imageImport(buffer, filename, file.mimetype);
      } catch (error) {
        if (error instanceof Error && error.message.includes("OPENAI_API_KEY")) {
          return reply.status(503).send({ error: "OpenAI ещё не настроен для импорта скриншотов." });
        }
        request.log.error({ err: error }, "Не удалось распознать скриншот заказа");
        return reply.status(502).send({ error: "Не удалось прочитать скриншот. Проверьте файл и повторите попытку." });
      }
    } finally {
      activeOrderImports -= 1;
    }
  });

  app.get("/vehicles", async () => {
    const vehicles = await vehicleService.list();
    return vehicles.map((vehicle) => ({
      ...toIsoObject(vehicle),
      tours: vehicle.tours.map(toIsoObject),
      disclaimer: CALCULATED_POSITION_DISCLAIMER
    }));
  });

  app.post("/vehicles", async (request, reply) => {
    const body = vehicleSchema.parse(request.body);
    const vehicle = await vehicleService.create(body);
    await audit(request, 'VEHICLE_CREATED', 'Vehicle', vehicle.id, { vehicleId: vehicle.id, metadata: { vehicleNumber: vehicle.vehicleNumber } });
    return reply.status(201).send(toIsoObject(vehicle));
  });

  app.get("/vehicles/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const vehicle = await vehicleService.getDetails(id);
    return {
      ...toIsoObject(vehicle),
      tours: vehicle.tours.map(toIsoObject),
      events: vehicle.events.map(toIsoObject),
      alerts: vehicle.alerts.map(toIsoObject),
      disclaimer: CALCULATED_POSITION_DISCLAIMER
    };
  });

  app.get("/vehicles/:id/tours", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const tours = await prisma.tour.findMany({
      where: { vehicleId: id },
      include: tourInclude,
      orderBy: [{ plannedStartAt: "asc" }, { createdAt: "asc" }]
    });
    return enrichToursWithSchedule(tours);
  });

  app.put("/vehicles/:id/manual-position", { config: { rateLimit: routingRateLimit } }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { address } = z.object({ address: z.string().trim().min(3).max(2000) }).parse(request.body);
    const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id } });
    const place = await routingService.geocode(address);
    const activeTour = await prisma.tour.findFirst({
      where: { vehicleId: id, status: "ACTIVE" },
      include: { stops: { orderBy: { sequence: "asc" } }, legs: true }
    });
    const first = activeTour?.stops.find((stop) => !stop.completedAt);
    const needsApproach = first && first.sequence === 1 && !first.arrivedAt
      && !activeTour?.legs.some((leg) => leg.toStopId === first.id && leg.status !== "COMPLETED");
    const route = needsApproach ? await routingService.calculateRoute(
      { latitude: place.latitude, longitude: place.longitude },
      { latitude: first.latitude, longitude: first.longitude },
      { traffic: true, source: "manual", truck: { maxSpeedKmh: vehicle.maxSpeedKmh } }
    ) : null;
    const duration = route ? calculateSimulatedDuration(route.distanceMeters, route.durationSeconds, vehicle.maxSpeedKmh) : null;
    await prisma.$transaction(async (tx) => {
      await tx.vehicle.update({ where: { id }, data: {
        manualPositionAddress: address,
        manualPositionLatitude: place.latitude,
        manualPositionLongitude: place.longitude,
        manualPositionAt: new Date()
      } });
      if (activeTour && route) {
        const changed = await tx.tour.updateMany({
          where: { id: activeTour.id, planVersion: activeTour.planVersion, status: "ACTIVE" },
          data: {
            approachDurationSeconds: duration,
            approachDistanceMeters: route.distanceMeters,
            approachGeometry: JSON.stringify(route.geometry),
            planVersion: { increment: 1 }
          }
        });
        if (!changed.count) throw Object.assign(new Error("Маршрут изменился. Укажите позицию повторно."), { statusCode: 409 });
      }
      await tx.operationEvent.create({ data: {
        vehicleId: id, tourId: activeTour?.id ?? null,
        type: "MANUAL_POSITION_SET",
        reason: "Позиция указана диспетчером; не GPS.",
        payloadJson: JSON.stringify({ address, latitude: place.latitude, longitude: place.longitude })
      } });
      await writeAuditLog(tx, auditActor(request), { action: "VEHICLE_MANUAL_POSITION_SET", entityType: "Vehicle", entityId: id, vehicleId: id, tourId: activeTour?.id ?? null,
        metadata: { address } });
    });
    await refreshAlertsForVehicle(id);
    return { address, latitude: place.latitude, longitude: place.longitude, approachDurationSeconds: duration };
  });

  app.get("/geocode", { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const { address } = z.object({ address: z.string().trim().min(1) }).parse(request.query);
    const result = await routingService.geocode(address);
    return { address: result.label, ...result };
  });

  app.post("/geocode/resolve", { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const input = z.object({
      address: z.string().trim().min(1).max(2000),
      city: z.string().trim().max(300).nullable().optional()
    }).parse(request.body);
    const result = await resolveAddressWithFallback(routingService, input, addressResearcher);
    return { address: result.resolvedAddress, ...result };
  });

  app.get("/tours", async (request) => {
    const query = z.object({ vehicleId: z.string().optional(), status: z.string().optional() }).parse(request.query);
    const tours = await prisma.tour.findMany({
      where: {
        vehicleId: query.vehicleId,
        status: query.status ? { equals: query.status as never } : undefined
      },
      include: tourInclude,
      orderBy: [{ plannedStartAt: "asc" }, { createdAt: "asc" }]
    });
    return enrichToursWithScheduleGroupedByVehicle(tours);
  });

  app.post("/tours", async (request, reply) => {
    const input = createTourSchema.parse(request.body);
    const tour = await tourService.createTour(input, auditActor(request));
    return reply.status(201).send(enrichTour(tour));
  });

  app.post("/imports/tours/confirm", { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { importAttemptId, importFingerprint, ...input } = confirmImportedTourSchema.parse(request.body);
    const result = await tourService.createImportedTour(input, { importAttemptId, importFingerprint }, auditActor(request));
    return reply.status(result.created ? 201 : 200).send({
      tour: enrichTour(result.tour),
      created: result.created,
      reused: !result.created
    });
  });

  app.post("/tours/with-new-vehicle", async (request, reply) => {
    const input = z.object({
      vehicle: z.object({ vehicleNumber: z.string().trim().min(1).max(100), licensePlate: z.string().trim().max(100).optional() }),
      tour: createTourSchema.omit({ vehicleId: true })
    }).parse(request.body);
    const result = await tourService.createTourForNewVehicle(input, auditActor(request));
    return reply.status(201).send({ vehicle: toIsoObject(result.vehicle), tour: enrichTour(result.tour) });
  });

  app.post("/tours/preview", { config: { rateLimit: routingRateLimit } }, async (request) => {
    const input = z.object({
      vehicleId: z.string().optional(),
      stops: z.array(z.object({
        address: z.string().trim().min(1),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional()
      })).min(2).max(20)
    }).parse(request.body);
    const vehicle = input.vehicleId ? await prisma.vehicle.findUniqueOrThrow({ where: { id: input.vehicleId } }) : null;
    const coordinates = [];
    for (const stop of input.stops) {
      const place = typeof stop.latitude === "number" && typeof stop.longitude === "number"
        ? { latitude: stop.latitude, longitude: stop.longitude }
        : await routingService.geocode(stop.address);
      coordinates.push({ latitude: place.latitude, longitude: place.longitude });
    }
    let origin = vehicle?.manualPositionLatitude != null && vehicle.manualPositionLongitude != null
      ? { latitude: vehicle.manualPositionLatitude, longitude: vehicle.manualPositionLongitude } : null;
    if (vehicle) {
      const current = await currentPosition(vehicle.id);
      if (current.position) origin = current.position;
    }
    const points = origin ? [origin, ...coordinates] : coordinates;
    const route = await routingService.calculateMultiStopRoute(points, { traffic: true, source: "manual", truck: vehicle ? { maxSpeedKmh: vehicle.maxSpeedKmh } : undefined });
    const durationSeconds = calculateSimulatedDuration(route.distanceMeters, route.durationSeconds, vehicle?.maxSpeedKmh ?? 85);
    const forecast = origin && vehicle ? forecastDrive(parseClockState(vehicle.clockState, new Date()), durationSeconds, new Date()) : null;
    return {
      distanceMeters: route.distanceMeters,
      durationSeconds,
      estimatedArrivalAt: forecast?.endAt ?? null,
      preliminary: !origin || !vehicle?.clockState,
      geometry: route.geometry.map((point) => [point.longitude, point.latitude])
    };
  });

  app.get("/tours/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const tour = await prisma.tour.findUniqueOrThrow({ where: { id }, include: tourInclude });
    return enrichTour(tour);
  });

  app.patch("/tours/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = patchTourSchema.parse(request.body);
    const tour = "status" in body
      ? await tourService.cancelFutureTour(id, new Date(), auditActor(request))
      : await tourService.updateFutureTour(id, body, auditActor(request));
    await refreshAlertsForVehicle(tour.vehicleId);
    return enrichTour(tour);
  });

  app.post("/stops/:id/loaded", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ timestamp: z.string().datetime().optional(), note: z.string().optional() }).parse(request.body ?? {});
    const tour = await tourService.recordLoaded(id, body.timestamp ? new Date(body.timestamp) : new Date(), body.note, auditActor(request));
    await refreshAlertsForVehicle(tour.vehicleId);
    return enrichTour(tour);
  });

  app.post("/stops/:id/unloaded", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ timestamp: z.string().datetime().optional(), note: z.string().optional() }).parse(request.body ?? {});
    const tour = await tourService.recordUnloaded(id, body.timestamp ? new Date(body.timestamp) : new Date(), body.note, auditActor(request));
    await refreshAlertsForVehicle(tour.vehicleId);
    return enrichTour(tour);
  });

  app.get("/vehicles/:id/current-position", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { geometry } = z.object({ geometry: z.enum(["0", "1"]).optional() }).parse(request.query);
    const result = await currentPosition(id);
    if (geometry !== "0") return result;
    return withoutPositionGeometry(result);
  });

  app.get('/integrations/webfleet/status', async () => ({
    ...await webfleetSync.status(),
    details: {
      drivingTimes: feedStatus(webfleetLive.drivingFeed),
      vehicles: feedStatus(webfleetLive.vehicleFeed),
      couplings: feedStatus(webfleetLive.couplingFeed),
      events: feedStatus(webfleetLive.eventFeed),
      trips: feedStatus(webfleetLive.tripFeed),
      optiDrive: feedStatus(webfleetLive.optiDriveFeed),
      maintenance: feedStatus(webfleetLive.maintenanceFeed)
    }
  }));
  app.get('/integrations/webfleet/suggestions', async () => suggestWebfleetBindings(prisma, webfleetLive.allObjects()));
  app.get('/vehicles/:id/card', async (request) => {
    const { id } = z.object({ id: z.string().trim().min(1).max(64) }).parse(request.params);
    return buildVehicleCard(prisma, webfleetLive, (vehicleId, now) => webfleetTelemetry.latest(vehicleId, now), id);
  });
  app.get('/vehicles/:id/track', async (request) => {
    const { id } = z.object({ id: z.string().trim().min(1).max(64) }).parse(request.params);
    return webfleetTracks.track(await vehicleObjectUid(prisma, id));
  });
  app.post('/integrations/webfleet/sync', { preHandler: requireDispatcherRoles('admin') }, async (request) => {
    await webfleetSync.refreshIfDue();
    await audit(request, 'WEBFLEET_SYNC_REQUESTED', 'Integration', 'webfleet');
    return webfleetSync.status();
  });
  app.get('/integrations/webfleet/bindings', async () => listWebfleetBindings(prisma));
  app.post('/integrations/webfleet/bindings', { preHandler: requireDispatcherRoles('admin') }, async (request) => {
    const body = z.object({
      objectUid: z.string().trim().min(1).max(128),
      vehicleId: z.string().trim().min(1).max(64),
      objectNo: z.string().trim().max(64).optional(),
      licensePlate: z.string().trim().max(32).optional()
    }).parse(request.body);
    const binding = await bindWebfleetObject(prisma, body);
    await webfleetSync.forgetUnmatched(binding.externalId);
    await writeAuditLog(prisma, auditActor(request), {
      action: 'WEBFLEET_BOUND', entityType: 'VehicleIntegration', entityId: binding.id, vehicleId: binding.vehicleId,
      metadata: { objectUid: binding.externalId, objectNo: binding.externalNumber }
    });
    return listWebfleetBindings(prisma);
  });
  app.delete('/integrations/webfleet/bindings/:vehicleId', { preHandler: requireDispatcherRoles('admin') }, async (request) => {
    const { vehicleId } = z.object({ vehicleId: z.string().trim().min(1).max(64) }).parse(request.params);
    const binding = await unbindWebfleetVehicle(prisma, vehicleId);
    await writeAuditLog(prisma, auditActor(request), {
      action: 'WEBFLEET_UNBOUND', entityType: 'VehicleIntegration', entityId: binding.id, vehicleId,
      metadata: { objectUid: binding.externalId }
    });
    return listWebfleetBindings(prisma);
  });

  app.get("/vehicles/:id/timeline", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id },
      include: {
        tours: {
          where: { status: { in: ["ACTIVE", "QUEUED", "COMPLETED"] } },
          include: { stops: { orderBy: { sequence: "asc" } }, legs: { orderBy: { createdAt: "asc" } } },
          orderBy: [{ plannedStartAt: "asc" }, { createdAt: "asc" }]
        }
      }
    });
    const schedule = etaService.calculateVehicleSchedule(vehicle.tours);
    const items = vehicle.tours.flatMap((tour) => buildTimelineItems(tour));
    return {
      vehicle: toIsoObject(vehicle),
      tours: vehicle.tours.map(toIsoObject),
      items,
      disclaimer: CALCULATED_POSITION_DISCLAIMER,
      schedule: schedule.map(toIsoObject),
      chain: vehicle.tours.flatMap((tour) =>
        tour.stops.map((stop) => ({
          ...toIsoObject(stop),
          orderNumber: tour.orderNumber,
          status: stop.completedAt ? "DONE" : tour.status === "QUEUED" ? "QUEUED" : "NEXT"
        }))
      )
    };
  });

  app.get("/history", async (request) => {
    const query = z.object({
      vehicleId: z.string().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional()
    }).parse(request.query);
    const { vehicleId } = query;
    const period = query.from || query.to ? { gte: query.from ? new Date(query.from) : undefined, lte: query.to ? new Date(query.to) : undefined } : undefined;
    // History only grows; the page shows the newest records and says when older ones are left out.
    const [tours, events, operationEvents] = await Promise.all([
      prisma.tour.findMany({
        where: { vehicleId, createdAt: period },
        include: tourInclude,
        orderBy: [{ plannedStartAt: "desc" }, { createdAt: "desc" }],
        take: HISTORY_LIMITS.tours + 1
      }),
      prisma.event.findMany({
        where: { vehicleId, timestamp: period },
        include: { vehicle: true, tour: true, stop: true },
        orderBy: { timestamp: "desc" },
        take: HISTORY_LIMITS.events + 1
      }),
      prisma.operationEvent.findMany({ where: { vehicleId, createdAt: period }, orderBy: { createdAt: 'desc' }, take: HISTORY_LIMITS.events + 1 })
    ]);
    const truncated = tours.length > HISTORY_LIMITS.tours || events.length > HISTORY_LIMITS.events || operationEvents.length > HISTORY_LIMITS.events;
    tours.splice(HISTORY_LIMITS.tours);
    events.splice(HISTORY_LIMITS.events);
    operationEvents.splice(HISTORY_LIMITS.events);
    return {
      generatedAt: new Date().toISOString(),
      truncated,
      limits: HISTORY_LIMITS,
      tours: enrichToursWithScheduleGroupedByVehicle(tours),
      events: events.map(toIsoObject),
      operationEvents,
      timeReports: tours.flatMap(tour => tour.stops.filter(stop => stop.arrivedAt).map(stop => ({
        vehicleId: tour.vehicleId, tourId: tour.id, stopId: stop.id, city: stop.city, type: stop.type,
        arrivedAt: stop.arrivedAt, completedAt: stop.completedAt,
        durationMinutes: Math.max(0, Math.floor(((stop.completedAt ?? new Date()).getTime() - stop.arrivedAt!.getTime()) / 60_000))
      })))
    };
  });

  // Alerts are recalculated by the background tick every 15 s; reading them never writes.
  app.get("/alerts", async () => {
    const alerts = await prisma.alert.findMany({
      where: { resolvedAt: null },
      include: { vehicle: true, stop: true, tour: true },
      orderBy: [{ predictedLateMinutes: "desc" }, { appointmentAt: "asc" }]
    });
    return alerts.map(toIsoObject);
  });

  app.get("/dashboard", async (request) => {
    const generatedAt = new Date();
    const me = request.dispatcherSession?.dispatcherId ?? null;
    const vehicles = await prisma.vehicle.findMany({
      include: {
        assignedDispatcher: { select: { id: true, displayName: true } },
        issues: { where: { resolvedAt: null }, orderBy: { createdAt: 'desc' } },
        tours: {
          where: { status: { in: ["ACTIVE", "QUEUED"] } },
          include: tourInclude,
          orderBy: [{ plannedStartAt: "asc" }, { createdAt: "asc" }]
        }
      },
      orderBy: { vehicleNumber: "asc" }
    });

    // Each truck needs a few small queries; running a handful at once keeps the 10 s poll fast as the fleet grows.
    const frontendVehicles = await mapWithConcurrency(vehicles, DASHBOARD_CONCURRENCY, async (vehicle) => {
      const breakdown = vehicle.issues.find(issue => issue.kind === 'BREAKDOWN');
      const activeTour = vehicle.tours.find((tour) => tour.status === "ACTIVE");
      const currentLeg = activeTour?.legs.find((leg) => leg.status === "ACTIVE" || leg.status === "ARRIVED");
      const fromStop = currentLeg ? activeTour?.stops.find((stop) => stop.id === currentLeg.fromStopId) : undefined;
      const toStop = currentLeg ? activeTour?.stops.find((stop) => stop.id === currentLeg.toStopId) : undefined;
      const [calculatedPosition, latestTelemetry, lastOperation] = await Promise.all([
        tourService.getCurrentPosition(vehicle.id),
        webfleetTelemetry.latest(vehicle.id, generatedAt),
        prisma.operationEvent.findFirst({ where: { vehicleId: vehicle.id }, orderBy: { createdAt: "desc" } })
      ]);
      const position = withWebfleetPosition(calculatedPosition, latestTelemetry);
      const currentStop = activeTour?.stops.find((stop) => !stop.completedAt) ?? null;
      const scheduledStop = currentStop ? etaService.calculateVehicleSchedule(vehicle.tours, generatedAt).find((stop) => stop.stopId === currentStop.id) : null;
      const displayedEta = position.eta ?? scheduledStop?.predictedEta?.toISOString() ?? null;
      const displayedDelayMinutes = scheduledStop?.predictedDelayMinutes ?? position.delayMinutes;
      const riskColor = scheduledStop?.riskColor ?? calculateRiskColor(displayedEta ? new Date(displayedEta) : null, currentStop?.appointmentAt);
      const dwell = calculateDwellState(currentStop, generatedAt);
      const clockSnapshot = snapshotVehicleClock(vehicle, currentLeg ?? null, generatedAt).clockState;
      const statusStartedAt = vehicle.manualStoppedAt
        ?? currentStop?.arrivedAt
        ?? currentLeg?.startedAt
        ?? activeTour?.actualStartAt
        ?? activeTour?.plannedStartAt
        ?? null;
      const currentAction = breakdown ? null : vehicle.manualStoppedAt
        ? { type: "RESUME", label: "Продолжить", stopId: null }
        : currentStop?.arrivedAt
          ? {
              type: currentStop.type === "LOAD" ? "MARK_LOADED" : "MARK_UNLOADED",
              label: currentStop.type === "LOAD" ? "BELADEN" : "ENTLADEN",
              stopId: currentStop.id
            }
          : currentStop && position.status === "ARRIVED"
            ? { type: "CONFIRM_ARRIVAL", label: "Прибыла", stopId: currentStop.id }
            : position.status === "MOVING"
              ? { type: "MANUAL_STOP", label: "Стоп", stopId: null }
              : null;
      const clockSummary = {
        preliminary: clockSnapshot.kind !== "KNOWN",
        remainingDrivingMinutes: clockSnapshot.kind === "KNOWN" ? Math.max(0, Math.floor(((clockSnapshot.currentCycle.extendedDriveReservationId ? VEHICLE_CLOCK_LIMITS.extendedDailyDrivingSeconds : VEHICLE_CLOCK_LIMITS.normalDailyDrivingSeconds) - clockSnapshot.currentCycle.drivingSeconds) / 60)) : null,
        breakInMinutes: clockSnapshot.kind === "KNOWN" ? Math.max(0, Math.floor((VEHICLE_CLOCK_LIMITS.breakAfterDrivingSeconds - clockSnapshot.currentCycle.continuousDrivingSeconds) / 60)) : null,
        remainingDutyMinutes: clockSnapshot.kind === "KNOWN" ? Math.max(0, Math.floor(((clockSnapshot.currentCycle.reducedRestReservationId ? VEHICLE_CLOCK_LIMITS.extendedDutyWindowSeconds : VEHICLE_CLOCK_LIMITS.normalDutyWindowSeconds) - clockSnapshot.currentCycle.dutySeconds) / 60)) : null,
        nextRestHours: clockSnapshot.kind === "KNOWN" ? ((clockSnapshot.currentCycle.reducedRestReservationId ? VEHICLE_CLOCK_LIMITS.reducedDailyRestSeconds : VEHICLE_CLOCK_LIMITS.normalDailyRestSeconds) / 3600) : null
      };

      return {
        vehicle: toIsoObject({
          id: vehicle.id,
          vehicleNumber: vehicle.vehicleNumber,
          licensePlate: vehicle.licensePlate,
          currentTrailerPlate: vehicle.currentTrailerPlate,
          maxSpeedKmh: vehicle.maxSpeedKmh,
          createdAt: vehicle.createdAt,
          updatedAt: vehicle.updatedAt
        }),
        operationVersion: vehicle.operationVersion,
        assignedTo: vehicle.assignedDispatcher ? { id: vehicle.assignedDispatcher.id, name: vehicle.assignedDispatcher.displayName } : null,
        mine: Boolean(me && vehicle.assignedDispatcherId === me),
        tour: activeTour ? toDashboardTourSummary(activeTour) : null,
        statusText: position.status,
        from: fromStop ? toIsoObject(fromStop) : null,
        to: toStop ? toIsoObject(toStop) : null,
        appointmentAt: toStop?.appointmentAt?.toISOString() ?? null,
        eta: displayedEta,
        travelledKm: Math.round((position.distanceTravelledMeters / 1000) * 10) / 10,
        remainingKm: Math.round((position.remainingDistanceMeters / 1000) * 10) / 10,
        delayMinutes: displayedDelayMinutes,
        risk: riskColor,
        warning: riskColor !== "GREEN" && riskColor !== "GREY" ? riskColor : null,
        currentStop: currentStop ? toIsoObject(currentStop) : null,
        dwellMinutes: dwell.dwellMinutes,
        dwellSeverity: dwell.dwellSeverity,
        currentAction,
        issues: vehicle.issues.map(toIsoObject),
        statusStartedAt: statusStartedAt?.toISOString() ?? null,
        statusDurationSeconds: statusStartedAt ? Math.max(0, Math.floor((generatedAt.getTime() - statusStartedAt.getTime()) / 1000)) : null,
        lastOperation: lastOperation ? toIsoObject(lastOperation) : null,
        clockSummary,
        telemetry: latestTelemetry ? {
          source: "WEBFLEET",
          checkedAt: latestTelemetry.recordedAt.toISOString(),
          stale: latestTelemetry.stale,
          ageSeconds: latestTelemetry.ageSeconds,
          speedKmh: latestTelemetry.speedKmh,
          ignitionOn: latestTelemetry.ignitionOn,
          standstill: latestTelemetry.standstill,
          courseDeg: latestTelemetry.courseDeg,
          fuelPercent: latestTelemetry.fuelPercent,
          address: latestTelemetry.address,
          objectNo: latestTelemetry.objectNo,
          objectName: latestTelemetry.objectName,
          usable: latestTelemetry.usable
        } : { source: "CALCULATED", checkedAt: generatedAt.toISOString(), stale: false, ageSeconds: 0, usable: true },
        // Every truck on the fleet map: where it is and where that position comes from.
        mapPosition: position.coordinate ? {
          coordinate: position.coordinate,
          source: position.positionSource ?? "CALCULATED",
          stale: position.positionSource === "WEBFLEET" ? Boolean(position.telemetryStale) : null,
          courseDeg: position.positionSource === "WEBFLEET" ? latestTelemetry?.courseDeg ?? null : null,
          standstill: position.positionSource === "WEBFLEET" ? latestTelemetry?.standstill ?? null : null
        } : null
      };
    });

    return {
      generatedAt: generatedAt.toISOString(),
      me,
      vehicles: frontendVehicles,
      disclaimer: CALCULATED_POSITION_DISCLAIMER
    };
  });

  return app;
}

// Vercel's Fastify adapter loads src/app.ts and requires the application as the
// default export. Local development continues to use src/server.ts.
const vercelApp = process.env.VERCEL ? await buildApp() : null;
if (vercelApp) await vercelApp.ready();
export default vercelApp?.server;

async function refreshAllAlerts() {
  const vehicles = await prisma.vehicle.findMany({
    include: {
      tours: {
        where: { status: { in: ["ACTIVE", "QUEUED"] } },
        include: { stops: { orderBy: { sequence: "asc" } }, legs: { orderBy: { createdAt: "asc" } } },
        orderBy: [{ plannedStartAt: "asc" }, { createdAt: "asc" }]
      }
    }
  });

  for (const vehicle of vehicles) {
    const schedule = etaService.calculateVehicleSchedule(vehicle.tours);
    await alertService.refreshVehicleAlerts(vehicle.id, schedule);
  }
}

async function refreshAlertsForVehicle(vehicleId: string) {
  const vehicle = await prisma.vehicle.findUniqueOrThrow({
    where: { id: vehicleId },
    include: {
      tours: {
        where: { status: { in: ["ACTIVE", "QUEUED"] } },
        include: { stops: { orderBy: { sequence: "asc" } }, legs: { orderBy: { createdAt: "asc" } } },
        orderBy: [{ plannedStartAt: "asc" }, { createdAt: "asc" }]
      }
    }
  });
  await alertService.refreshVehicleAlerts(vehicle.id, etaService.calculateVehicleSchedule(vehicle.tours));
}

function isPrismaRecordNotFound(error: unknown): boolean {
  // Duck-typed: the SQLite and PostgreSQL generated clients have distinct error classes.
  return typeof error === "object" && error !== null
    && (error as { name?: unknown }).name === "PrismaClientKnownRequestError"
    && (error as { code?: unknown }).code === "P2025";
}

function hasStatusCode(error: unknown): error is { statusCode: number } {
  return typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number";
}

function hasPdfHeader(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function hasImageHeader(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return buffer.length >= 8
      && buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4e
      && buffer[3] === 0x47
      && buffer[4] === 0x0d
      && buffer[5] === 0x0a
      && buffer[6] === 0x1a
      && buffer[7] === 0x0a;
  }
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/webp") {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString("ascii") === "RIFF"
      && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function imageExtensionMatchesMimeType(filename: string, mimeType: string): boolean {
  if (mimeType === "image/png") return filename.endsWith(".png");
  if (mimeType === "image/jpeg") return filename.endsWith(".jpg") || filename.endsWith(".jpeg");
  if (mimeType === "image/webp") return filename.endsWith(".webp");
  return false;
}

function mapTimelineLegStatus(legStatus: string, tourStatus: string): "DONE" | "CURRENT" | "NEXT" | "QUEUED" {
  if (legStatus === "COMPLETED") return "DONE";
  if (legStatus === "ACTIVE" || legStatus === "ARRIVED") return "CURRENT";
  if (tourStatus === "QUEUED") return "QUEUED";
  return "NEXT";
}

function buildTimelineItems(tour: {
  status: string;
  orderNumber: string;
  stops: Array<{ id: string; completedAt: Date | null; type: string; address: string } & Record<string, unknown>>;
  legs: Array<{
    id: string;
    fromStopId: string;
    toStopId: string;
    status: string;
    distanceMeters: number;
  } & Record<string, unknown>>;
}) {
  const items: Array<Record<string, unknown>> = [];
  const stopIds = new Set(tour.stops.map((stop) => stop.id));
  const firstStop = tour.stops[0];
  const transferLeg = firstStop
    ? tour.legs.find((leg) => leg.toStopId === firstStop.id && !stopIds.has(leg.fromStopId))
    : undefined;

  if (transferLeg) items.push(toTimelineLeg(transferLeg, tour.status, tour.orderNumber));

  for (const stop of tour.stops) {
    const incomingLeg = tour.legs.find((leg) => leg.toStopId === stop.id);
    const stopStatus = stop.completedAt
      ? "DONE"
      : tour.status === "QUEUED"
        ? "QUEUED"
        : incomingLeg?.status === "ACTIVE" || incomingLeg?.status === "ARRIVED"
          ? "CURRENT"
          : "NEXT";
    items.push({
      id: stop.id,
      kind: "STOP",
      status: stopStatus,
      stop: toIsoObject(stop),
      label: `${stop.type === "LOAD" ? "Загрузка" : "Выгрузка"} ${stop.address}`,
      meta: `Заказ ${tour.orderNumber}`
    });

    const outgoingLeg = tour.legs.find((leg) => leg.fromStopId === stop.id && stopIds.has(leg.toStopId));
    if (outgoingLeg) items.push(toTimelineLeg(outgoingLeg, tour.status, tour.orderNumber));
  }

  return items;
}

function toTimelineLeg(
  leg: { id: string; status: string; distanceMeters: number } & Record<string, unknown>,
  tourStatus: string,
  orderNumber: string
) {
  return {
    id: leg.id,
    kind: "LEG",
    status: mapTimelineLegStatus(leg.status, tourStatus),
    leg: toIsoObject(leg),
    label: `${Math.round(leg.distanceMeters / 1000)} км`,
    meta: `Заказ ${orderNumber}`
  };
}

function enrichToursWithSchedule(tours: TourAggregate[]) {
  const schedule = etaService.calculateVehicleSchedule(tours);
  const scheduleByTour = new Map<string, (typeof schedule)[number]>();
  for (const item of schedule) {
    scheduleByTour.set(item.tourId, item);
  }

  return tours.map((tour) => {
    const enriched = enrichTour(tour);
    const item = scheduleByTour.get(tour.id);
    return {
      ...enriched,
      predictedEta: item?.predictedEta?.toISOString() ?? enriched.currentEta,
      predictedDelayMinutes: item?.predictedDelayMinutes ?? enriched.currentDelayMinutes
    };
  });
}

function enrichToursWithScheduleGroupedByVehicle(tours: TourAggregate[]) {
  const byVehicle = new Map<string, TourAggregate[]>();
  for (const tour of tours) {
    const group = byVehicle.get(tour.vehicleId) ?? [];
    group.push(tour);
    byVehicle.set(tour.vehicleId, group);
  }

  const enrichedById = new Map<string, ReturnType<typeof enrichToursWithSchedule>[number]>();
  for (const group of byVehicle.values()) {
    for (const tour of enrichToursWithSchedule(group)) {
      enrichedById.set(tour.id, tour);
    }
  }

  return tours.map((tour) => enrichedById.get(tour.id) ?? enrichTour(tour));
}

function feedStatus(feed: WebfleetLiveStore['drivingFeed']) {
  return {
    checkedAt: feed.at ? new Date(feed.at).toISOString() : null,
    errorCategory: feed.error,
    providerErrorCode: feed.providerCode
  };
}

function withWebfleetPosition(
  calculated: CurrentPosition,
  telemetry: Awaited<ReturnType<WebfleetTelemetryService['latest']>>
): CurrentPosition {
  if (!telemetry || !telemetry.usable) return { ...calculated, positionSource: calculated.positionSource ?? 'CALCULATED' };
  return {
    ...calculated,
    position: { latitude: telemetry.latitude, longitude: telemetry.longitude },
    coordinate: [telemetry.longitude, telemetry.latitude],
    positionSource: 'WEBFLEET',
    telemetryRecordedAt: telemetry.recordedAt.toISOString(),
    telemetryAgeSeconds: telemetry.ageSeconds,
    telemetryStale: telemetry.stale,
    disclaimer: telemetry.stale
      ? `Webfleet GPS устарел: ${Math.max(1, Math.ceil(telemetry.ageSeconds / 60))} мин назад`
      : 'Фактическая позиция Webfleet GPS'
  };
}
