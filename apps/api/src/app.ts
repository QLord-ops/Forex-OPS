import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { z } from "zod";
import { CALCULATED_POSITION_DISCLAIMER } from "./domain.js";
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
import { validateXlsxArchive } from "./services/xlsx-validation.js";
import { enrichTour, type TourAggregate, toIsoObject, tourInclude, TourService } from "./services/tours.js";
import { VehicleService } from "./services/vehicles.js";
import { calculateDwellState, NotificationService } from "./services/notifications.js";
import { OperationsService } from "./services/operations.js";
import { ReplanningService } from "./services/replanning.js";
import { PrismaTrafficQuotaStore, TomTomRoutingProvider, TrafficRoutingService } from './services/traffic-routing.js';
import { TrafficOperationsService } from './services/traffic-operations.js';

const trafficQuota = new PrismaTrafficQuotaStore(prisma);
const trafficProvider = new TomTomRoutingProvider(trafficQuota, new OsrmRoutingProvider());
const routingService = new RoutingService(trafficProvider);
const tourService = new TourService(prisma, routingService);
const etaService = new EtaService();
const alertService = new AlertService(prisma);
const vehicleService = new VehicleService(prisma);
const notificationService = new NotificationService(prisma, tourService);
const operationsService = new OperationsService(prisma, tourService);
const appointmentService = new AppointmentService(prisma, etaService, (id, now) => tourService.getCurrentPosition(id, now));
const replanningService = new ReplanningService(prisma, routingService, (id, now) => tourService.getCurrentPosition(id, now));
const trafficService = new TrafficOperationsService(prisma, tourService, notificationService, new TrafficRoutingService(trafficProvider, trafficQuota));

const vehicleSchema = z.object({
  vehicleNumber: z.string().trim().min(1),
  licensePlate: z.string().trim().optional(),
  maxSpeedKmh: z.number().int().positive().max(85).default(85)
});

const stopSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.enum(["LOAD", "UNLOAD"]),
  company: z.string().optional(),
  address: z.string().trim().min(1),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  city: z.string().trim().max(200).nullable().optional(),
  serviceMinMinutes: z.number().int().min(0).max(10080).default(60),
  serviceMaxMinutes: z.number().int().min(0).max(10080).default(120),
  appointmentAt: z.string().datetime().nullable().optional()
}).refine(stop => stop.serviceMaxMinutes >= stop.serviceMinMinutes, {
  message: "Максимальное время стоянки не может быть меньше минимального."
});

const createTourSchema = z.object({
  vehicleId: z.string().min(1),
  orderNumber: z.string().trim().min(1),
  stops: z.array(stopSchema).min(2)
});

const patchTourSchema = z.union([
  z.object({ status: z.literal("CANCELLED") }),
  createTourSchema
]);

export interface BuildAppOptions {
  pdfImport?: (buffer: Buffer, filename: string) => Promise<PdfImportPreview>;
  imageImport?: (buffer: Buffer, filename: string, mimeType: "image/png" | "image/jpeg" | "image/webp") => Promise<ImageImportPreview>;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const isServerless = Boolean(process.env.VERCEL);

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 1,
      parts: 2,
      fileSize: 20 * 1024 * 1024
    }
  });

  let activeOrderImports = 0;
  const pdfImport = options.pdfImport ?? importPdfPreview;
  const imageImport = options.imageImport ?? importImagePreview;
  const subscribers = new Set<import('node:http').ServerResponse>();
  let notificationTimer: ReturnType<typeof setInterval> | undefined;
  let refreshingNotifications = false;
  let lastNotificationRefreshAt = 0;
  const refreshNotifications = async () => {
    if (refreshingNotifications) return;
    refreshingNotifications = true;
    try {
      await notificationService.refresh();
      await trafficService.tick();
      lastNotificationRefreshAt = Date.now();
      for (const client of subscribers) client.write(`event: operations\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    } catch (error) { app.log.error(error); }
    finally { refreshingNotifications = false; }
  };
  app.addHook('onListen', async () => {
    if (isServerless) return;
    await refreshNotifications();
    notificationTimer = setInterval(() => { void refreshNotifications(); }, 15_000);
    notificationTimer.unref();
  });
  app.addHook('onRequest', async request => {
    if (!isServerless || request.method !== 'GET' || request.url === '/health' || request.url === '/events/stream') return;
    if (Date.now() - lastNotificationRefreshAt >= 10_000) await refreshNotifications();
  });
  app.addHook('onClose', async () => {
    if (notificationTimer) clearInterval(notificationTimer);
    for (const client of subscribers) client.end();
    subscribers.clear();
  });

  app.get('/notifications', async () => ({ notifications: await notificationService.list() }));
  app.post('/notifications/:id/ack', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await notificationService.acknowledge(id);
    return { ok: true };
  });
  app.get('/events/stream', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // On reconnect clients reload durable unread notifications rather than relying on transient event IDs.
    reply.raw.write('retry: 3000\nevent: operations\ndata: {}\n\n');
    subscribers.add(reply.raw);
    request.raw.on('close', () => subscribers.delete(reply.raw));
  });

  app.setErrorHandler((error, _request, reply) => {
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

  app.get("/health", async () => ({ ok: true, service: "@ops/api", timestamp: new Date().toISOString() }));

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
    return operationsService.setClock(idParams.parse(request.params).id, input);
  });
  app.post('/vehicles/:id/manual-stop', async request => operationsService.manualStop(idParams.parse(request.params).id, versionInput.parse(request.body).version));
  app.post('/vehicles/:id/resume', async request => {
    const id = idParams.parse(request.params).id;
    const { version } = versionInput.parse(request.body);
    const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id } });
    if (vehicle.operationVersion !== version || !vehicle.manualStoppedAt) throw Object.assign(new Error('Состояние грузовика изменилось или он не остановлен.'), { statusCode: 409 });
    const refreshed = await trafficService.refresh(id, 'manual');
    return operationsService.resume(id, refreshed.version);
  });
  app.get('/vehicles/:id/traffic', async request => trafficService.status(idParams.parse(request.params).id));
  app.post('/vehicles/:id/traffic/refresh', async request => trafficService.refresh(idParams.parse(request.params).id, 'manual'));
  app.post('/vehicles/:id/traffic/accept', async request => {
    const input = versionInput.extend({ index: z.number().int().min(0).max(1), origin: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional() }).parse(request.body);
    return trafficService.accept(idParams.parse(request.params).id, input.index, input.version, input.origin);
  });
  app.post('/vehicles/:id/traffic/reject', async request => trafficService.reject(idParams.parse(request.params).id, versionInput.parse(request.body).version));
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
    });
    return operationsService.get(vehicleId);
  });
  app.post('/vehicles/:id/weekly-rest', async request => {
    const input = versionInput.extend({ reason: z.string().trim().min(3).max(2000) }).parse(request.body);
    return operationsService.weeklyRest(idParams.parse(request.params).id, input.version, input.reason);
  });
  app.post('/vehicles/:id/exceptions', async request => {
    const input = versionInput.extend({ kind: z.enum(['EXTENDED_DRIVING', 'REDUCED_REST', 'BOTH']) }).parse(request.body);
    return operationsService.acceptException(idParams.parse(request.params).id, input.version, input.kind);
  });
  app.delete('/vehicles/:id/exceptions', async request => operationsService.cancelExceptions(idParams.parse(request.params).id, versionInput.parse(request.body).version));
  app.post('/stops/:id/arrival', async request => {
    const input = z.object({ arrivedAt: z.string().datetime().optional() }).parse(request.body ?? {});
    return operationsService.confirmArrival(idParams.parse(request.params).id, input.arrivedAt ? new Date(input.arrivedAt) : new Date());
  });
  app.post('/stops/:id/not-arrived', async request => {
    const input = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).parse(request.body);
    const stop = await prisma.stop.findUniqueOrThrow({ where: { id: idParams.parse(request.params).id }, include: { tour: { include: { stops: { orderBy: { sequence: 'asc' } } } } } });
    if (stop.arrivedAt || stop.completedAt || stop.tour.stops.find(item => !item.completedAt)?.id !== stop.id) throw Object.assign(new Error('Требуется текущая неподтверждённая точка.'), { statusCode: 409 });
    const preview = await replanningService.preview(stop.tourId, { version: stop.tour.planVersion, origin: input,
      futureStops: stop.tour.stops.filter(item => !item.completedAt).map(item => ({ ...item, type: item.type as 'LOAD' | 'UNLOAD', appointmentAt: item.appointmentAt?.toISOString() ?? null })) });
    await replanningService.apply(stop.tourId, { previewId: preview.id, version: preview.version });
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
    await refreshAlertsForVehicle(analysis.vehicleId);
    return analysis;
  });
  app.post('/tours/:id/replan/preview', async request => {
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
  app.post('/tours/:id/replan/apply', async request => {
    const input = versionInput.extend({ previewId: z.string().min(1) }).parse(request.body);
    return replanningService.apply(idParams.parse(request.params).id, input);
  });

  app.post("/imports/excel/preview", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: "Файл Excel необходимо отправить как multipart/form-data в поле 'file'." });
    }
    if (activeOrderImports >= 2) {
      return reply.status(429).send({ error: "Слишком много одновременных импортов Excel. Повторите попытку позже." });
    }

    activeOrderImports += 1;
    try {
      const file = await request.file();
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
      if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        return reply.status(415).send({ error: "Файл не является корректной книгой .xlsx." });
      }

      try {
        validateXlsxArchive(buffer);
      } catch (error) {
        request.log.warn({ err: error, filename }, "Отклонена небезопасная или повреждённая книга Excel");
        return reply.status(422).send({ error: "Не удалось безопасно прочитать книгу Excel." });
      }
      let result;
      try {
        result = await importExcelPreview(buffer, filename);
      } catch (error) {
        request.log.error({ err: error, filename }, "Не удалось разобрать книгу Excel");
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

  app.post("/imports/pdf/preview", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: "PDF-заказ необходимо отправить как multipart/form-data в поле 'file'." });
    }
    if (activeOrderImports >= 2) {
      return reply.status(429).send({ error: "Слишком много одновременных импортов заказов. Повторите попытку позже." });
    }

    activeOrderImports += 1;
    try {
      const file = await request.file();
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

  app.post("/imports/image/preview", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: "Скриншот необходимо отправить как multipart/form-data в поле 'file'." });
    }
    if (activeOrderImports >= 2) {
      return reply.status(429).send({ error: "Слишком много одновременных импортов заказов. Повторите попытку позже." });
    }

    activeOrderImports += 1;
    try {
      const file = await request.file();
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

  app.get("/geocode", async (request) => {
    const { address } = z.object({ address: z.string().trim().min(1) }).parse(request.query);
    const result = await routingService.geocode(address);
    return { address: result.label, ...result };
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
    const tour = await tourService.createTour(input);
    return reply.status(201).send(enrichTour(tour));
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
      ? await tourService.cancelFutureTour(id)
      : await tourService.updateFutureTour(id, body);
    await refreshAlertsForVehicle(tour.vehicleId);
    return enrichTour(tour);
  });

  app.post("/stops/:id/loaded", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ timestamp: z.string().datetime().optional(), note: z.string().optional() }).parse(request.body ?? {});
    const tour = await tourService.recordLoaded(id, body.timestamp ? new Date(body.timestamp) : new Date(), body.note);
    await refreshAlertsForVehicle(tour.vehicleId);
    return enrichTour(tour);
  });

  app.post("/stops/:id/unloaded", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ timestamp: z.string().datetime().optional(), note: z.string().optional() }).parse(request.body ?? {});
    const tour = await tourService.recordUnloaded(id, body.timestamp ? new Date(body.timestamp) : new Date(), body.note);
    await refreshAlertsForVehicle(tour.vehicleId);
    return enrichTour(tour);
  });

  app.get("/vehicles/:id/current-position", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return tourService.getCurrentPosition(id);
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
    const { vehicleId } = z.object({ vehicleId: z.string().optional() }).parse(request.query);
    const tours = await prisma.tour.findMany({
      where: { vehicleId },
      include: tourInclude,
      orderBy: [{ plannedStartAt: "desc" }, { createdAt: "desc" }]
    });
    const events = await prisma.event.findMany({
      where: { vehicleId },
      include: { vehicle: true, tour: true, stop: true },
      orderBy: { timestamp: "desc" }
    });
    return {
      generatedAt: new Date().toISOString(),
      tours: enrichToursWithScheduleGroupedByVehicle(tours),
      events: events.map(toIsoObject),
      operationEvents: await prisma.operationEvent.findMany({ where: { vehicleId }, orderBy: { createdAt: 'desc' } }),
      timeReports: tours.flatMap(tour => tour.stops.filter(stop => stop.arrivedAt).map(stop => ({
        vehicleId: tour.vehicleId, tourId: tour.id, stopId: stop.id, city: stop.city, type: stop.type,
        arrivedAt: stop.arrivedAt, completedAt: stop.completedAt,
        durationMinutes: Math.max(0, Math.floor(((stop.completedAt ?? new Date()).getTime() - stop.arrivedAt!.getTime()) / 60_000))
      })))
    };
  });

  app.get("/alerts", async () => {
    await refreshAllAlerts();
    const alerts = await prisma.alert.findMany({
      where: { resolvedAt: null },
      include: { vehicle: true, stop: true, tour: true },
      orderBy: [{ predictedLateMinutes: "desc" }, { appointmentAt: "asc" }]
    });
    return alerts.map(toIsoObject);
  });

  app.get("/dashboard", async () => {
    await refreshAllAlerts();
    const generatedAt = new Date();
    const vehicles = await prisma.vehicle.findMany({
      include: {
        tours: {
          where: { status: { in: ["ACTIVE", "QUEUED"] } },
          include: tourInclude,
          orderBy: [{ plannedStartAt: "asc" }, { createdAt: "asc" }]
        }
      },
      orderBy: { vehicleNumber: "asc" }
    });

    const rows = [];
    const frontendVehicles = [];
    for (const vehicle of vehicles) {
      const activeTour = vehicle.tours.find((tour) => tour.status === "ACTIVE");
      const currentLeg = activeTour?.legs.find((leg) => leg.status === "ACTIVE" || leg.status === "ARRIVED");
      const fromStop = currentLeg ? activeTour?.stops.find((stop) => stop.id === currentLeg.fromStopId) : undefined;
      const toStop = currentLeg ? activeTour?.stops.find((stop) => stop.id === currentLeg.toStopId) : undefined;
      const position = await tourService.getCurrentPosition(vehicle.id);
      const enriched = activeTour ? enrichTour(activeTour) : null;
      const currentStop = activeTour?.stops.find((stop) => !stop.completedAt) ?? null;
      const dwell = calculateDwellState(currentStop, generatedAt);

      rows.push({
        vehicleId: vehicle.id,
        lkw: vehicle.vehicleNumber,
        aktuellerStatus: position.state,
        von: fromStop?.address ?? null,
        nach: toStop?.address ?? null,
        termin: toStop?.appointmentAt?.toISOString() ?? null,
        eta: position.eta,
        gefahrenMeters: position.distanceTravelledMeters,
        reststreckeMeters: position.remainingDistanceMeters,
        verspaetungMinutes: enriched?.currentDelayMinutes ?? 0,
        warnung: enriched?.riskColor ?? "GREY",
        disclaimer: CALCULATED_POSITION_DISCLAIMER
      });
      frontendVehicles.push({
        vehicle: toIsoObject({
          id: vehicle.id,
          vehicleNumber: vehicle.vehicleNumber,
          licensePlate: vehicle.licensePlate,
          maxSpeedKmh: vehicle.maxSpeedKmh,
          createdAt: vehicle.createdAt,
          updatedAt: vehicle.updatedAt
        }),
        tour: activeTour ? enrichTour(activeTour) : null,
        statusText: position.status,
        from: fromStop ? toIsoObject(fromStop) : null,
        to: toStop ? toIsoObject(toStop) : null,
        appointmentAt: toStop?.appointmentAt?.toISOString() ?? null,
        eta: position.eta,
        travelledKm: Math.round((position.distanceTravelledMeters / 1000) * 10) / 10,
        remainingKm: Math.round((position.remainingDistanceMeters / 1000) * 10) / 10,
        delayMinutes: enriched?.currentDelayMinutes ?? position.delayMinutes,
        risk: enriched?.riskColor ?? "GREY",
        warning: enriched?.riskColor && enriched.riskColor !== "GREEN" && enriched.riskColor !== "GREY" ? enriched.riskColor : null,
        currentStop: currentStop ? toIsoObject(currentStop) : null,
        dwellMinutes: dwell.dwellMinutes,
        dwellSeverity: dwell.dwellSeverity
      });
    }

    const endangered = rows
      .filter((row) => row.verspaetungMinutes > 0)
      .sort((a, b) => b.verspaetungMinutes - a.verspaetungMinutes);

    const alerts = await prisma.alert.findMany({
      where: { resolvedAt: null },
      include: { vehicle: true, tour: true, stop: true },
      orderBy: [{ predictedLateMinutes: "desc" }, { appointmentAt: "asc" }]
    });
    const riskyAppointments = alerts.map((alert) => ({
      vehicle: toIsoObject(alert.vehicle),
      tour: toIsoObject(alert.tour),
      stop: toIsoObject(alert.stop),
      eta: alert.predictedEta.toISOString(),
      delayMinutes: alert.predictedLateMinutes,
      alertType: alert.type
    }));

    return {
      generatedAt: generatedAt.toISOString(),
      vehicles: frontendVehicles,
      riskyAppointments,
      rows,
      termineInGefahr: endangered,
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

function hasStatusCode(error: unknown): error is { statusCode: number } {
  return typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number";
}

function hasPdfHeader(buffer: Buffer): boolean {
  const headerWindow = buffer.subarray(0, Math.min(buffer.length, 1024)).toString("latin1");
  return headerWindow.includes("%PDF-");
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
      predictedEta: item?.predictedEta.toISOString() ?? enriched.currentEta,
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
