import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { CALCULATED_POSITION_DISCLAIMER, type CurrentPosition, type GpsFix, withoutPositionGeometry } from "./domain.js";
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
import { OpenPlzChecker, TomTomPlaceSearch } from "./services/address-check.js";
import { BudgetedAddressResearcher } from "./services/address-research.js";
import { validateXlsxArchive } from "./services/xlsx-validation.js";
import { enrichTour, snapshotVehicleClock, type TourAggregate, toDashboardTourSummary, toIsoObject, tourInclude, findToursForList, withoutDrawnRoute, TourService } from "./services/tours.js";
import { VehicleService } from "./services/vehicles.js";
import { calculateDwellState, NotificationService } from "./services/notifications.js";
import { OperationsService, SYSTEM_WEBFLEET_ACTOR } from "./services/operations.js";
import { ReplanningService } from "./services/replanning.js";
import { StopCoordinatesService } from "./services/stop-coordinates.js";
import { PrismaTrafficQuotaStore, TomTomRoutingProvider, TrafficRoutingService } from './services/traffic-routing.js';
import { TrafficOperationsService } from './services/traffic-operations.js';
import { RouteDeviationService } from './services/route-deviation.js';
import { RestAtStopService } from './services/rest-at-stop.js';
import { AddressRuleService, applyRulesToStop, BUILT_IN_RULES } from './services/address-rules.js';
import { VEHICLE_CLOCK_LIMITS } from './services/vehicle-clock.js';
import { bindWebfleetObject, listWebfleetBindings, unbindWebfleetVehicle, WebfleetSyncService, WebfleetTelemetryService, distanceMeters, DEFAULT_ARRIVAL_RADIUS_METERS, type AutoArrivalHandler, type AutoStopEventHandler } from './services/webfleet.js';
import { buildVehicleCard, readDriverBudget, readDriverHours, suggestWebfleetBindings, vehicleObjectUid, WebfleetDetailsSync, WebfleetLiveStore, WebfleetTrackService } from './services/webfleet-live.js';
import { TerminService } from './services/termin-service.js';
import { withTerminGroups } from './services/termin-groups.js';
import { VehicleBriefService } from './services/vehicle-brief.js';
import { calculateRiskColor, calculateSimulatedDuration } from './services/simulation.js';
import { forecastDrive } from './services/vehicle-clock.js';
import { forecastEta, WebfleetEngine } from './services/termin-planner.js';
import { forecastClock, parseClockState } from './services/tours.js';
import { registerDispatcherAuth, requireDispatcherRoles, type DispatcherAuthOptions } from './services/dispatcher-auth.js';
import { RouteScenarioService, routeScenarioInputSchema } from './services/route-scenario.js';
import { registerRouteScenarioRoutes } from './routes/route-scenario.js';
import { AssistantError, DispatcherAssistantService } from './services/dispatcher-assistant.js';
import { assistantSessionKey, registerDispatcherAssistantRoutes } from './routes/dispatcher-assistant.js';
import { registerDispatcherRoutes } from './routes/dispatchers.js';
import { registerVehicleAssignmentRoutes } from './routes/vehicle-assignment.js';
import { registerVehicleStatusSettingsRoutes } from './routes/vehicle-status-settings.js';
import { registerDailyStatusRoutes } from './routes/daily-status.js';
import { registerAddressBookRoutes } from './routes/address-book.js';
import { AddressBookSync } from './services/address-book.js';
import { DailyStatusService } from './services/daily-status.js';
import { createDispatcherDependencies } from './services/dispatcher-adapters.js';
import { writeAuditLog, type AuditActor } from './services/audit-log.js';
import { matchAppointment } from './services/appointment-match.js';
import { documentFingerprint, PendingAppointmentService } from './services/pending-appointments.js';
import { OrderDocumentService } from './services/order-documents.js';
import { ImportJobError, ImportJobs, type ImportJobHandle } from './services/import-jobs.js';
import { TelemetryRetention, TELEMETRY_SYSTEM_ACTOR } from './services/telemetry-retention.js';
import { registerOrderDocumentRoutes, registerOrderReparseRoute } from './routes/order-documents.js';
import { CustomerService, isMine } from './services/customers.js';
import { PushService } from './services/push.js';
import { registerPushRoutes } from './routes/push.js';
import { resolveImportCustomer, vehicleKey, type ImportCustomer } from './services/customer-resolver.js';
import { scoreDraft } from './services/field-confidence.js';
import { berlinToday } from './services/order-dates.js';
import { registerCustomerRoutes } from './routes/customers.js';
import { ImportLearningService } from './services/import-learning.js';
import { registerImportRuleRoutes } from './routes/import-rules.js';
import { registerAppointmentDocumentRoutes } from './routes/appointments.js';
import type { CustomerEvidence, DocumentImportPreview, ImportCustomerContext, ReadStats } from './services/pdf-order-import.js';
import { storedAnswerOf } from './services/order-documents.js';
import { KnownPlaces, resolveWithoutGeocoder } from './services/known-places.js';
import { OwnAddressBook } from './services/own-addresses.js';
import { readingFromStore } from './services/import-reuse.js';

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
const addressSources = { checker: new OpenPlzChecker(), places: new TomTomPlaceSearch() };
const tourService = new TourService(prisma, routingService);
const etaService = new EtaService();
const alertService = new AlertService(prisma);
const vehicleService = new VehicleService(prisma);
// A truck on daily rest at its stop is not a «long stop»: the rest notice already told the dispatcher why.
const notificationService: NotificationService = new NotificationService(prisma, tourService, (vehicleId, stopId): boolean => restAtStop.restAt(vehicleId)?.stopId === stopId);
const addressRules = new AddressRuleService(prisma);
const operationsService = new OperationsService(prisma, tourService);
const pendingAppointments = new PendingAppointmentService(prisma);
const orderDocuments = new OrderDocumentService(prisma);
const knownPlaces = new KnownPlaces(prisma);
const ownAddresses = new OwnAddressBook(prisma, () => knownPlaces.reset());
const telemetryRetention = new TelemetryRetention(prisma);
const importLearning = new ImportLearningService(prisma, addressRules);
const customerService = new CustomerService(prisma);
const pushService = new PushService(prisma);

/**
 * The trucks a dispatcher follows in pop-ups and on the phone: not those a colleague took, and not free trucks on lines
 * other dispatchers work on, once the dispatcher has lines of their own. The shared login sees everything.
 */
async function visibleTo(dispatcherId: string | null | undefined): Promise<(vehicleId: string) => boolean> {
  if (!dispatcherId) return () => true;
  const myLines = await customerService.linesOf(dispatcherId);
  const others = new Set((await prisma.vehicle.findMany({ where: { OR: [
    { assignedDispatcherId: { not: null, notIn: [dispatcherId] } },
    ...(myLines.length ? [{ assignedDispatcherId: null, customerLineId: { not: null, notIn: myLines }, customerLine: { dispatchers: { some: {} } } }] : [])
  ] }, select: { id: true } })).map((vehicle) => vehicle.id));
  return (vehicleId) => !others.has(vehicleId);
}
const ORDER_DOCUMENT_SYSTEM_ACTOR: AuditActor = { role: 'system', sessionId: 'order-documents' };

/** A Termin slip gets its truck and stop match and tells whether the same file was used before. */
/** A corrected place with a street and coordinates becomes a rule for its imported label. Failures never block the tour. */
async function learnAddressRules(stops: Array<{ learnLabel?: string | null; company?: string; address: string; city?: string | null; latitude?: number; longitude?: number; geocodePrecision?: string | null }>, actor?: AuditActor) {
  for (const stop of stops) {
    if (!stop.learnLabel || stop.latitude === undefined || stop.longitude === undefined || !/\d/.test(stop.address)) continue;
    if (stop.geocodePrecision && stop.geocodePrecision !== "EXACT" && stop.geocodePrecision !== "STREET") continue;
    const postalCode = stop.address.match(/\b\d{5}\b/)?.[0] ?? null;
    const street = stop.address.split(",")[0]?.trim() || null;
    await addressRules.learn({ sourceLabel: stop.learnLabel, company: stop.company?.trim() || null, street, postalCode, city: stop.city ?? null,
      latitude: stop.latitude, longitude: stop.longitude }, actor).catch(() => undefined);
  }
}

/** Recognised stops pass the address rules: city codes, company names, learned places and the Termin a customer still owes. */
async function withAddressRules<T extends { drafts: Array<{ stops: Array<{ company: string | null; address: string | null; city?: string | null; appointmentLocal: string | null; appointmentWindowStartLocal?: string | null }>; warnings: Array<{ code: string; message: string }> }> }>(preview: T): Promise<T> {
  if (!preview.drafts?.length) return preview;
  const [rules, places] = await Promise.all([addressRules.all(), knownPlaces.all().catch(() => [])]);
  return { ...preview, drafts: preview.drafts.map((draft) => {
    // A place the fleet already knows comes with its coordinates, so the page has nothing to look up for it.
    const stops = draft.stops.map((stop) => applyRulesToStop(stop, rules)).map((stop) => ({ ...stop, resolution: resolveWithoutGeocoder(stop, rules, places) }));
    const missing = stops.flatMap((stop, index) => !stop.ruleApplied && (stop.address ?? "").trim() === (stop.city ?? "").trim() && stop.company ? [{ code: "ADDRESS_FROM_RULE_MISSING", stopIndex: index, field: "address" as const,
      message: `Адрес ${stop.company}, ${stop.city ?? ""} не указан в Auftrag — введите его, он запомнится для следующих Auftrag.` }] : []);
    return { ...draft, stops, warnings: [...draft.warnings, ...missing] };
  }) };
}

async function withAppointmentMatch<T extends DocumentImportPreview>(preview: T, buffer: Buffer) {
  if (preview.documentKind !== 'APPOINTMENT' || !preview.appointment) return withAddressRules(preview);
  const fingerprint = documentFingerprint(buffer);
  const [match, previous] = await Promise.all([matchAppointment(prisma, preview.appointment), pendingAppointments.findByFingerprint(fingerprint)]);
  return { ...preview, appointment: { ...preview.appointment, fingerprint }, match, previous: previous ? { id: previous.id, status: previous.status, attachedStopId: previous.attachedStopId } : null };
}

/**
 * Links the saved Auftrag to the tour just created and learns from what the dispatcher changed against the stored
 * AI preview (the client never sends the original). Another tour already owning the file is logged, nothing else breaks.
 */
async function attachDocument(documentId: string, tourId: string, vehicleId: string, confirmed: { orderNumber: string; tourRemarks?: string | null; stops: Array<z.infer<typeof stopSchema>> }, request: FastifyRequest) {
  try {
    const attached = await orderDocuments.attach({ documentId, tourId, vehicleId, confirmedJson: confirmed, actor: auditActor(request) });
    if (!attached || attached.tourId !== tourId) return;
    const document = await orderDocuments.get(documentId);
    if (!document) return;
    await importLearning.recordConfirmation({
      documentId, tourId, dispatcherId: request.dispatcherSession?.dispatcherId ?? null, customerId: document.customerId, preview: JSON.parse(document.previewJson) as unknown,
      orderNumber: confirmed.orderNumber, confirmedStops: confirmed.stops, tourRemarks: confirmed.tourRemarks ?? null, actor: auditActor(request)
    });
  } catch (error) {
    // A file with several Auftrag stays with its first tour; the preview already warned about a re-upload.
    request.log.warn({ err: error }, 'Auftrag не прикреплён к туру');
  }
}

/** Exact addresses of a saved tour go to the fleet's own address book. A failure never costs the dispatcher the tour. */
async function rememberAddresses(tourId: string, request: FastifyRequest) {
  await ownAddresses.rememberTour(tourId, auditActor(request)).catch((error: unknown) => {
    request.log.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Адреса тура не запомнены');
  });
}

/** Freshly created tours come back without their document relation; the card needs the link at once. */
async function withDocument<T extends TourAggregate>(tour: T): Promise<T> {
  const document = await orderDocuments.forTour(tour.id).catch(() => null);
  return { ...tour, document: document ? { id: document.id, filename: document.filename, mimeType: document.mimeType } : null };
}

/** Every reading takes the same way: Termin slip match or address rules → customer → field confidence → timings. */
async function finishRead<T extends DocumentImportPreview & { answerReused?: boolean }>(read: T, buffer: Buffer, customerContext: ImportCustomerContext, contextMs: number, startedAt: number) {
  const checked = await withFieldConfidence(await withCustomer(await withAppointmentMatch(read, buffer), customerContext));
  return read.answerReused ? checked : withReadTimings(checked, contextMs, startedAt);
}

/** Adds what the route measured to the reading's own numbers, before the parse is stored with its document. */
function withReadTimings<T extends { readStats?: ReadStats }>(preview: T, contextMs: number, startedAt: number): T {
  return preview.readStats ? { ...preview, readStats: { ...preview.readStats, contextMs, totalMs: contextMs + Date.now() - startedAt } } : preview;
}

/** The Auftrag file stays with the tour it will create. A storage failure never costs the dispatcher the parse. */
async function withStoredDocument<T extends { documentKind?: string; drafts: Array<unknown>; warnings: Array<{ code: string; message: string }>; customer?: ImportCustomer | null; modelAnswer?: unknown; answerReused?: boolean; readStats?: unknown }>(full: T, file: { buffer: Buffer; filename: string; mimeType: string }, request: FastifyRequest) {
  // The model's raw answer stays in the database for the next reading of this file; the page never gets it.
  // A reading taken from the store shows no timings: they belong to the first reading and stay with the stored row.
  const preview = { ...full, modelAnswer: undefined, ...(full.answerReused ? { readStats: undefined } : {}) };
  if (preview.documentKind === 'APPOINTMENT' || !preview.drafts?.length) return { ...preview, documentId: null, documentReused: false, attachedTourId: null };
  try {
    const stored = await orderDocuments.store({ ...file, previewJson: { ...full, answerReused: undefined }, customerId: preview.customer?.id ?? null, actor: auditActor(request) });
    const warnings = stored.attachedTourId
      ? [...preview.warnings, { code: 'DOCUMENT_ALREADY_ATTACHED', message: 'Этот файл уже сохранён с другим туром — проверьте, не дубль ли это.' }]
      : preview.warnings;
    return { ...preview, warnings, documentId: stored.id, documentReused: stored.reused, attachedTourId: stored.attachedTourId };
  } catch (error) {
    request.log.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Auftrag не сохранён в базе; разбор отдан без документа');
    return { ...preview, documentId: null, documentReused: false, attachedTourId: null };
  }
}
/** `?customerId=` of an import: a customer id, or nothing / "auto" for automatic detection. */
async function importCustomerContext(request: FastifyRequest): Promise<ImportCustomerContext> {
  const { customerId } = z.object({ customerId: z.string().trim().max(64).optional() }).parse(request.query ?? {});
  const selected = customerId && customerId !== 'auto' ? customerId : null;
  // Without a choice the import still runs when the customer list cannot be read; a chosen customer must exist.
  return selected ? customerService.importContext(selected) : customerService.importContext(null).catch(() => ({ cards: [], selected: null }));
}

/** Customers of the trucks the Auftrag names (number or plate → the truck's line). */
async function vehicleCustomerIds(drafts: Array<{ vehicleNumber?: string | null; vehiclePlate?: string | null }>): Promise<string[]> {
  const wanted = new Set(drafts.flatMap((draft) => [vehicleKey(draft.vehicleNumber), vehicleKey(draft.vehiclePlate)]).filter(Boolean));
  if (!wanted.size) return [];
  const vehicles = await prisma.vehicle.findMany({ where: { customerLineId: { not: null } }, select: { vehicleNumber: true, licensePlate: true, customerLine: { select: { customerId: true } } } });
  return [...new Set(vehicles.filter((vehicle) => wanted.has(vehicleKey(vehicle.vehicleNumber)) || (vehicle.licensePlate && wanted.has(vehicleKey(vehicle.licensePlate))))
    .map((vehicle) => vehicle.customerLine?.customerId).filter((id): id is string => Boolean(id)))];
}

/** The preview learns whose Auftrag it is; a failed lookup never costs the dispatcher the parse. */
async function withCustomer<T extends { documentKind?: string; drafts: Array<{ vehicleNumber?: string | null; vehiclePlate?: string | null }>; warnings: Array<{ code: string; message: string }>; customerEvidence?: CustomerEvidence }>(
  preview: T, context: ImportCustomerContext
): Promise<T & { customer: ImportCustomer | null }> {
  if (preview.documentKind === 'APPOINTMENT' || !preview.drafts?.length) return { ...preview, customer: null };
  const vehicles = await vehicleCustomerIds(preview.drafts).catch(() => []);
  const { customer, warnings } = resolveImportCustomer({ cards: context.cards, selectedId: context.selected?.id ?? null, evidence: preview.customerEvidence, vehicleCustomerIds: vehicles });
  return { ...preview, customer, warnings: [...preview.warnings.filter((warning) => !warning.code.startsWith('CUSTOMER_')), ...warnings] };
}

type ScorablePreview = { documentKind?: string; detectedLayout?: string; customer?: ImportCustomer | null; drafts: Array<Parameters<typeof scoreDraft>[0]> };

/** Every recognised field gets a level the check shows; the customer's correction history makes often-wrong fields stricter. */
async function withFieldConfidence<T extends ScorablePreview>(preview: T): Promise<T> {
  if (preview.documentKind === 'APPOINTMENT' || !preview.drafts?.length) return preview;
  const correctionRate = preview.customer?.id ? await importLearning.fieldHistory(preview.customer.id).catch(() => ({})) : {};
  const context = { ai: preview.detectedLayout === 'PDF' || preview.detectedLayout === 'IMAGE', today: berlinToday(), correctionRate };
  return { ...preview, drafts: preview.drafts.map((draft) => scoreDraft(draft, context)) };
}

// Automatic arrival from fresh Webfleet GPS (zone + standstill); AUTO_ARRIVAL_ENABLED=false keeps it a suggestion.
const autoArrival: AutoArrivalHandler | undefined = process.env.AUTO_ARRIVAL_ENABLED === 'false' ? undefined
  : (input) => operationsService.confirmArrival(input.stopId, input.arrivedAt, input.now, SYSTEM_WEBFLEET_ACTOR, { source: 'WEBFLEET_AUTO', meta: input.meta });
const webfleetLive = new WebfleetLiveStore();
// BELADEN/ENTLADEN by itself once the truck stood at the stop and left the town (real GPS); AUTO_STOP_EVENT_ENABLED=false keeps asking.
const autoStopEvent: AutoStopEventHandler | undefined = process.env.AUTO_STOP_EVENT_ENABLED === 'false' ? undefined
  : (input) => tourService.recordAutoStopEvent(input, SYSTEM_WEBFLEET_ACTOR);
const webfleetSync = new WebfleetSyncService(prisma, undefined, undefined, autoArrival, (positions, now) => webfleetLive.setObjects(positions, now), autoStopEvent);
const webfleetDetails = new WebfleetDetailsSync(webfleetLive);
const addressBook = new AddressBookSync(prisma);
const webfleetTracks = new WebfleetTrackService();
const webfleetTelemetry = new WebfleetTelemetryService(prisma, autoArrival, autoStopEvent);
// The driver's tachograph for the ETA (memory only); a Webfleet hiccup never breaks the position.
const driverBudget = (id: string, now: Date) => readDriverBudget(prisma, webfleetLive, id, now).catch(() => null);
const currentPosition = async (id: string, now = new Date()) => {
  const [telemetry, driver] = await Promise.all([webfleetTelemetry.latest(id, now), driverBudget(id, now)]);
  return withWebfleetPosition(await tourService.getCurrentPosition(id, now, gpsFixOf(telemetry), driver), telemetry);
};
async function enrichTourLive(tour: TourAggregate) {
  const now = new Date();
  return enrichTour(tour, now, await driverBudget(tour.vehicleId, now));
}
const appointmentService = new AppointmentService(prisma, etaService, currentPosition);
const replanningService = new ReplanningService(prisma, routingService, currentPosition);
const stopCoordinates = new StopCoordinatesService(prisma, routingService, () => addressRules.all(), replanningService);
const trafficService = new TrafficOperationsService(prisma, tourService, notificationService, new TrafficRoutingService(trafficProvider, trafficQuota), currentPosition);
const routeDeviation = new RouteDeviationService(prisma, currentPosition, (input) => notificationService.publish(input),
  (vehicleId, now) => trafficService.rerouteFromGps(vehicleId, now));
const restAtStop: RestAtStopService = new RestAtStopService(prisma, webfleetLive, (input) => notificationService.publish(input));
const scenarioService = new RouteScenarioService(prisma, routingService, currentPosition);
const driverHours = (vehicleId: string, now: Date) => readDriverHours(prisma, webfleetLive, vehicleId, now);
const terminService = new TerminService(prisma, routingService, currentPosition, driverHours);
const briefService = new VehicleBriefService(prisma, etaService, currentPosition, driverHours, async (id, now) => (await webfleetTelemetry.latest(id, now))?.address ?? null);
const dailyStatus = new DailyStatusService(prisma, {
  getPosition: currentPosition,
  latestTelemetry: async (id, now) => { const telemetry = await webfleetTelemetry.latest(id, now); return telemetry ? { address: telemetry.address, stale: telemetry.stale } : null; },
  // The card is often out at 07:00: the last driver's figures still tell when the next shift may start (memory only).
  driverHours: (id, now) => readDriverHours(prisma, webfleetLive, id, now, { recent: true }),
  coupledTrailerNo: async (id) => { const coupling = webfleetLive.coupling(await vehicleObjectUid(prisma, id)); return coupling ? webfleetLive.objectNo(coupling.assetUid) : null; },
  webfleetReady: (now) => now.getTime() - webfleetLive.objectsAt < 3 * 60_000 && (webfleetLive.drivingFeed.at > 0 || webfleetLive.drivingFeed.error !== null),
  eta: etaService,
  startedAt: new Date()
});
const assistantService = new DispatcherAssistantService(prisma, createDispatcherDependencies(prisma, routingService,
  (input, vehicleId, now) => scenarioService.calculate(routeScenarioInputSchema.parse({ ...input, vehicleId }), now),
  { termin: (input, vehicleId, now) => terminService.plan(input, vehicleId, now), brief: (vehicleId, now) => briefService.build(vehicleId, now) }));

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
  appointmentAt: z.string().datetime().nullable().optional(),
  // Planned time without a Termin and the latest departure; never used for lateness.
  plannedAt: z.string().datetime().nullable().optional(),
  departureDeadlineAt: z.string().datetime().nullable().optional(),
  // The imported label the dispatcher corrected ("Seifert Bremen"): the corrected place is remembered for it.
  learnLabel: z.string().trim().min(2).max(300).nullable().optional(),
  /** Index of the preview stop this one came from, so the server can see what the dispatcher changed. */
  draftStopIndex: z.number().int().min(0).max(199).nullable().optional()
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

const documentIdSchema = z.string().trim().min(8).max(64).nullable().optional();
const confirmImportedTourSchema = createTourSchema.extend({
  importAttemptId: z.string().trim().min(8).max(200),
  importFingerprint: z.string().trim().min(8).max(200),
  documentId: documentIdSchema
});

const patchTourSchema = z.union([
  z.object({ status: z.literal("CANCELLED"), version: z.number().int().nonnegative().optional() }),
  createTourSchema.extend({ version: z.number().int().nonnegative().optional() })
]);

export interface BuildAppOptions {
  auth?: DispatcherAuthOptions;
  pdfImport?: (buffer: Buffer, filename: string, customer?: ImportCustomerContext | null) => Promise<PdfImportPreview>;
  imageImport?: (buffer: Buffer, filename: string, mimeType: "image/png" | "image/jpeg" | "image/webp", customer?: ImportCustomerContext | null) => Promise<ImageImportPreview>;
  databaseCheck?: () => Promise<unknown>;
  /** How long an Auftrag upload waits for the AI before answering «ещё читаем» (tests make it short). */
  importWaitMs?: number;
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
  registerAppointmentDocumentRoutes(app, { prisma, appointments: appointmentService, pending: pendingAppointments, audit, refreshAlertsForVehicle: (vehicleId) => refreshAlertsForVehicle(vehicleId) });
  registerDispatcherRoutes(app, prisma);
  registerVehicleAssignmentRoutes(app, prisma);
  registerVehicleStatusSettingsRoutes(app, prisma);
  registerDailyStatusRoutes(app, dailyStatus);
  registerAddressBookRoutes(app, prisma, addressBook, ownAddresses);
  registerOrderDocumentRoutes(app, orderDocuments);
  registerImportRuleRoutes(app, importLearning);
  registerCustomerRoutes(app, customerService);
  registerPushRoutes(app, pushService);
  await registerRouteScenarioRoutes(app, { service: scenarioService });

  let activeOrderImports = 0;
  // Reading an Auftrag may take minutes: the upload answers 202 with a job after this wait and the page asks for the result.
  // A serverless host cannot work on after the answer, so there the upload waits almost as long as its proxy allows.
  const importJobs = new ImportJobs();
  const importWaitMs = options.importWaitMs ?? (isServerless ? 110_000 : 20_000);
  const importOwner = (request: FastifyRequest) => assistantSessionKey(request);
  async function answerImportJob<T>(job: ImportJobHandle<T>, reply: FastifyReply) {
    const state = await job.settled(importWaitMs);
    if (state.status === "done") return state.result;
    if (state.status === "failed") return reply.status(state.statusCode).send({ error: state.error });
    return reply.status(202).send({ status: "running", jobId: job.id });
  }
  // What the dispatchers taught: import rules of the customer plus the city codes, which belong to everybody.
  const learnedRules = async (customerId: string | null) => {
    const [learned, rules] = await Promise.all([importLearning.learned(customerId).catch(() => null), addressRules.all().catch(() => [])]);
    const cityCodes = Object.fromEntries(rules.filter((rule) => rule.kind === "CITY_CODE" && rule.city).map((rule) => [rule.pattern, rule.city!]));
    return { aliases: {}, ignoreLabels: {}, stopTypes: {}, ...learned, cityCodes };
  };
  const pdfImport = options.pdfImport ?? (async (buffer, filename, customer) =>
    importPdfPreview(buffer, filename, { learned: await learnedRules(customer?.selected?.id ?? null), customer: customer ?? null }));
  const imageImport = options.imageImport ?? (async (buffer, filename, mimeType, customer) =>
    importImagePreview(buffer, filename, mimeType, { learned: await learnedRules(customer?.selected?.id ?? null), customer: customer ?? null }));
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
      await addressBook.refreshIfDue(new Date(), webfleetLive.objectsAt).catch((error) => app.log.error(error));
      await routeDeviation.check().catch((error) => app.log.error(error));
      await restAtStop.check().catch((error) => app.log.error(error));
      await notificationService.refresh();
      await pendingAppointments.scan((input) => notificationService.publish(input)).catch((error) => app.log.error(error));
      await refreshAllAlerts();
      await trafficService.tick();
      await dailyStatus.runIfDue(new Date()).catch((error) => app.log.error(error));
      // New decisions reach the dispatchers' phones even when the app is closed.
      await pushService.sweep(() => notificationService.list(), visibleTo).catch((error) => app.log.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Push не отправлен'));
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
  let documentPurgeTimer: ReturnType<typeof setInterval> | undefined;
  const purgeDocuments = () => orderDocuments.purge(new Date(), ORDER_DOCUMENT_SYSTEM_ACTOR).catch((error: unknown) => app.log.warn({ err: error }, 'Очистка старых Auftrag не удалась'));
  // GPS older than TELEMETRY_RETENTION_DAYS (5) goes hourly; a big backlog continues after 5 min instead of in one heavy run.
  let telemetryPurgeTimer: ReturnType<typeof setInterval> | undefined;
  let telemetryPurging = false;
  const purgeTelemetry = async (): Promise<void> => {
    if (telemetryPurging) return;
    telemetryPurging = true;
    try {
      const result = await telemetryRetention.purge(new Date(), TELEMETRY_SYSTEM_ACTOR);
      if (result.deleted) app.log.info({ deleted: result.deleted, more: result.more }, 'Старые GPS-позиции удалены');
      if (result.more) setTimeout(() => { void purgeTelemetry(); }, 5 * 60_000).unref();
    } catch (error) {
      app.log.warn({ errorType: error instanceof Error ? error.name : 'unknown' }, 'Очистка старых GPS-позиций не удалась');
    } finally { telemetryPurging = false; }
  };
  app.addHook('onListen', async () => {
    if (isServerless) return;
    await refreshNotifications();
    notificationTimer = setInterval(() => { void refreshNotifications(); }, 15_000);
    notificationTimer.unref();
    void purgeDocuments();
    documentPurgeTimer = setInterval(() => { void purgeDocuments(); }, 6 * 3600_000);
    documentPurgeTimer.unref();
    void purgeTelemetry();
    telemetryPurgeTimer = setInterval(() => { void purgeTelemetry(); }, 3600_000);
    telemetryPurgeTimer.unref();
  });
  app.addHook('onClose', async () => {
    if (notificationTimer) clearInterval(notificationTimer);
    if (documentPurgeTimer) clearInterval(documentPurgeTimer);
    if (telemetryPurgeTimer) clearInterval(telemetryPurgeTimer);
    for (const client of subscribers) client.end();
    subscribers.clear();
    subscriberSessions.clear();
  });

  app.get('/notifications', async (request) => {
    if (isServerless && Date.now() - lastNotificationRefreshAt >= 25_000) await refreshNotifications();
    const notifications = await notificationService.list();
    // Pop-ups follow the dispatcher's own and free trucks; the alerts page still lists everything.
    const visible = await visibleTo(request.dispatcherSession?.dispatcherId);
    return { notifications: notifications.filter((notification) => visible(notification.vehicleId)) };
  });
  app.post('/notifications/:id/ack', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await notificationService.acknowledge(id);
    await audit(request, 'NOTIFICATION_ACKNOWLEDGED', 'Notification', id);
    return { ok: true };
  });
  app.post('/notifications/ack-many', async (request) => {
    const { ids } = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(300) }).parse(request.body);
    const result = await notificationService.acknowledgeMany([...new Set(ids)]);
    await audit(request, 'NOTIFICATIONS_ACKNOWLEDGED', 'Notification', 'bulk', { metadata: { count: result.count } });
    return { ok: true, count: result.count };
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
  app.post('/vehicles/:id/route-options', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async request => {
    const id = idParams.parse(request.params).id;
    const result = await trafficService.routeOptions(id);
    await audit(request, 'ROUTE_OPTIONS_BUILT', 'Vehicle', id, { vehicleId: id, metadata: { count: result.options.length } });
    return result;
  });
  app.post('/vehicles/:id/route-options/apply', async request => {
    const input = versionInput.extend({ optionId: z.string().min(1).max(64) }).parse(request.body);
    const id = idParams.parse(request.params).id;
    const result = await trafficService.applyRouteOption(id, input.optionId, input.version);
    await audit(request, 'ROUTE_OPTION_SELECTED', 'Vehicle', id, { vehicleId: id, metadata: { optionId: input.optionId } });
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
  // Address rules learned from corrections, plus the built-in dictionary (read-only) for reference.
  app.get('/address-rules', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async () => ({
    rules: (await addressRules.list()).map((rule) => toIsoObject(rule)),
    builtIn: BUILT_IN_RULES.map(({ pattern, kind, company, city, requiresTermin }) => ({ pattern, kind, company, city, requiresTermin }))
  }));
  // «Что значит SZ?» answered in the check of an Auftrag: remembered at once, for every customer.
  app.post('/address-rules/city-codes', { preHandler: requireDispatcherRoles('admin', 'dispatcher'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = z.object({ code: z.string().trim().regex(/^\p{L}{1,4}$/u), city: z.string().trim().min(2).max(100).regex(/^[\p{L}][\p{L} .()'/-]*$/u) }).strict().parse(request.body);
    const rule = await addressRules.learnCityCode(input.code, input.city, auditActor(request));
    if (!rule) return reply.status(409).send({ error: 'Это сокращение уже занято выученным местом — измените его в «Правилах адресов».' });
    return reply.status(201).send(toIsoObject(rule));
  });
  app.patch('/address-rules/:id', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async request => {
    const id = idParams.parse(request.params).id;
    const patch = z.object({
      company: z.string().trim().max(300).nullable().optional(), street: z.string().trim().max(300).nullable().optional(),
      postalCode: z.string().trim().max(20).nullable().optional(), city: z.string().trim().max(200).nullable().optional(),
      requiresTermin: z.boolean().optional()
    }).strict().parse(request.body);
    return toIsoObject(await addressRules.update(id, patch, auditActor(request)));
  });
  app.delete('/address-rules/:id', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async (request, reply) => {
    await addressRules.remove(idParams.parse(request.params).id, auditActor(request));
    return reply.status(204).send();
  });
  // Stops drawn in the wrong town: the check resolves every future stop again (one geocoder call per second), so it runs
  // as a job the page polls; the fix moves the chosen stops and redraws the legs of their trucks.
  app.get('/maintenance/stop-coordinates', { preHandler: requireDispatcherRoles('admin') }, async (request, reply) => {
    const job = importJobs.start(importOwner(request), () => stopCoordinates.check(new Date()));
    return answerImportJob(job, reply);
  });
  app.post('/maintenance/stop-coordinates/fix', { preHandler: requireDispatcherRoles('admin') }, async (request, reply) => {
    const input = z.object({ stopIds: z.array(z.string().min(1)).min(1).max(200) }).parse(request.body);
    const actor = auditActor(request);
    const job = importJobs.start(importOwner(request), async () => {
      const result = await stopCoordinates.fix(input.stopIds, actor, new Date());
      await audit(request, 'STOP_COORDINATES_FIX_RUN', 'Stop', 'all', { metadata: { fixed: result.fixed.length, skipped: result.skipped.length } });
      return result;
    });
    return answerImportJob(job, reply);
  });
  app.post('/stops/:id/arrival/revert', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async request => {
    const input = z.object({ reason: z.string().trim().max(300).optional() }).parse(request.body ?? {});
    const { id } = idParams.parse(request.params);
    const result = await operationsService.revertArrival(id, new Date(), auditActor(request), input.reason || undefined);
    const stop = await prisma.stop.findUniqueOrThrow({ where: { id }, select: { tour: { select: { vehicleId: true } } } });
    await refreshAlertsForVehicle(stop.tour.vehicleId);
    return result;
  });
  app.post('/stops/:id/auto-event/revert', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async request => {
    const input = z.object({ reason: z.string().trim().max(300).optional() }).parse(request.body ?? {});
    const { id } = idParams.parse(request.params);
    const result = await tourService.revertAutoStopEvent(id, new Date(), auditActor(request), input.reason || undefined);
    const stop = await prisma.stop.findUniqueOrThrow({ where: { id }, select: { tour: { select: { vehicleId: true } } } });
    await refreshAlertsForVehicle(stop.tour.vehicleId);
    return result;
  });
  app.post('/stops/:id/departure/keep', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async request => {
    const { id } = idParams.parse(request.params);
    return operationsService.keepAfterDeparture(id, new Date(), auditActor(request));
  });
  app.put('/stops/:id/arrival-radius', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async request => {
    const input = z.object({ radiusMeters: z.number().int().min(100).max(5000).nullable() }).parse(request.body ?? {});
    return operationsService.setArrivalRadius(idParams.parse(request.params).id, input.radiusMeters, new Date(), auditActor(request));
  });
  const appointmentScope = z.enum(['PLACE', 'STOP']);
  app.post('/stops/:id/appointment/preview', async request => {
    const stopId = idParams.parse(request.params).id;
    const input = z.object({ appointmentAt: z.string().datetime().nullable().optional(), windowStartAt: z.string().datetime().nullable().optional(), windowEndAt: z.string().datetime().nullable().optional(), scope: appointmentScope.optional() }).parse(request.body);
    return appointmentService.preview(stopId, input, new Date(), input.scope);
  });
  app.put('/stops/:id/appointment', async request => {
    const stopId = idParams.parse(request.params).id;
    const input = versionInput.extend({ appointmentAt: z.string().datetime(), scope: appointmentScope.optional() }).parse(request.body);
    const analysis = await appointmentService.apply(stopId, input, new Date(), { scope: input.scope });
    await audit(request, 'STOP_APPOINTMENT_SET', 'Stop', analysis.appliedToStopId, { vehicleId: analysis.vehicleId, stopId: analysis.appliedToStopId,
      metadata: { appointmentAt: input.appointmentAt, requestedStopId: stopId, sharedStopIds: analysis.sharedStopIds, scope: input.scope ?? 'PLACE' } });
    await refreshAlertsForVehicle(analysis.vehicleId);
    return analysis;
  });
  app.post('/tours/:id/replan/preview', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async request => {
    const input = versionInput.extend({
      futureStops: z.array(z.object({
        id: z.string().optional(), type: z.enum(['LOAD', 'UNLOAD']), address: z.string().trim().min(1),
        company: z.string().optional(), city: z.string().nullable().optional(), appointmentAt: z.string().datetime().nullable().optional(),
        instructions: z.string().trim().max(4000).nullable().optional(),
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
      const customerContext = await importCustomerContext(request);
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
      return withStoredDocument(await withFieldConfidence(await withCustomer(await withAddressRules({
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
      }), customerContext)), { buffer, filename, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, request);
    } finally {
      activeOrderImports -= 1;
    }
  });

  registerOrderReparseRoute(app, {
    documents: orderDocuments, customers: customerService, db: prisma, jobs: importJobs, owner: importOwner, waitMs: importWaitMs,
    store: (preview, file, request) => withStoredDocument(preview, { buffer: file.content, filename: file.filename, mimeType: file.mimeType }, request),
    read: async (file, previewJson, customerContext, request) => {
      if (activeOrderImports >= 2) return { status: 429, error: "Слишком много одновременных импортов заказов. Повторите попытку позже." };
      activeOrderImports += 1;
      try {
        // Excel is read by its columns, not by a profile: only the customer of the stored parse changes.
        if (file.mimeType !== "application/pdf" && !isSupportedImageMimeType(file.mimeType)) {
          return { preview: await withFieldConfidence(await withCustomer(JSON.parse(previewJson) as ScorablePreview & { warnings: Array<{ code: string; message: string }> }, customerContext)) };
        }
        if (!options.auth?.disabled) await assistantService.consumeUsage(assistantSessionKey(request));
        try {
          const started = Date.now();
          const read = file.mimeType === "application/pdf"
            ? await pdfImport(file.content, file.filename, customerContext)
            : await imageImport(file.content, file.filename, file.mimeType as "image/png" | "image/jpeg" | "image/webp", customerContext);
          return { preview: await finishRead(read, file.content, customerContext, 0, started) };
        } catch (error) {
          if (error instanceof AssistantError) throw error;
          request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Не удалось заново разобрать Auftrag");
          return { status: 502, error: "Не удалось прочитать Auftrag заново. Повторите попытку позже." };
        }
      } finally {
        activeOrderImports -= 1;
      }
    },
    recompute: async (file, previewJson, customerContext) => {
      const layout = file.mimeType === "application/pdf" ? "PDF" as const : "IMAGE" as const;
      const again = await readingFromStore(storedAnswerOf({ id: "", status: "PENDING", previewJson }), layout, customerContext, () => learnedRules(customerContext.selected?.id ?? null));
      if (!again) return { status: 409, error: "Для этого Auftrag нет сохранённого ответа ИИ по этому заказчику — нажмите «Прочитать заново ИИ»." };
      // An answer to a question asked on purpose is not «the file was read before».
      return { preview: await finishRead({ ...again, warnings: again.warnings.filter((warning) => warning.code !== "DOCUMENT_REUSED") }, file.content, customerContext, 0, Date.now()) };
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
    let handedOff = false;
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

      const contextStarted = Date.now();
      // Whose Auftrag it is and whether this very file was read before are asked side by side.
      const [customerContext, before] = await Promise.all([importCustomerContext(request), orderDocuments.modelAnswerOf(buffer).catch(() => null)]);
      const reused = await readingFromStore(before, "PDF", customerContext, () => learnedRules(customerContext.selected?.id ?? null));
      // A reading taken from the store asks no model, so it does not count against the AI quota.
      if (!reused && !options.auth?.disabled) await assistantService.consumeUsage(assistantSessionKey(request));
      const contextMs = Date.now() - contextStarted;
      handedOff = true;
      const job = importJobs.start(importOwner(request), async () => {
        try {
          const started = Date.now();
          const read = reused ?? await pdfImport(buffer, filename, customerContext);
          const aiMs = Date.now() - started;
          const checked = await finishRead(read, buffer, customerContext, contextMs, started);
          request.log.info({ readMode: read.readMode ?? null, ...checked.readStats, aiMs, pdfBytes: buffer.length, answerReused: Boolean(reused) }, 'PDF-заказ распознан');
          return { ...await withStoredDocument(checked, { buffer, filename, mimeType: "application/pdf" }, request), readMs: Date.now() - started };
        } catch (error) {
          if (error instanceof Error && error.message.includes("OPENAI_API_KEY")) throw new ImportJobError("OpenAI ещё не настроен для импорта PDF.", 503);
          request.log.error({ err: error }, "Не удалось распознать PDF-заказ");
          throw new ImportJobError("Не удалось прочитать PDF-заказ. Проверьте файл и повторите попытку.", 502);
        }
      }, () => { activeOrderImports -= 1; });
      return answerImportJob(job, reply);
    } finally {
      if (!handedOff) activeOrderImports -= 1;
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
    let handedOff = false;
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

      const contextStarted = Date.now();
      const [customerContext, before] = await Promise.all([importCustomerContext(request), orderDocuments.modelAnswerOf(buffer).catch(() => null)]);
      const reused = await readingFromStore(before, "IMAGE", customerContext, () => learnedRules(customerContext.selected?.id ?? null));
      if (!reused && !options.auth?.disabled) await assistantService.consumeUsage(assistantSessionKey(request));
      const contextMs = Date.now() - contextStarted;
      handedOff = true;
      const mimeType = file.mimetype;
      const job = importJobs.start(importOwner(request), async () => {
        try {
          const started = Date.now();
          const read = reused ?? await imageImport(buffer, filename, mimeType, customerContext);
          const aiMs = Date.now() - started;
          const checked = await finishRead(read, buffer, customerContext, contextMs, started);
          request.log.info({ ...checked.readStats, aiMs, imageBytes: buffer.length, answerReused: Boolean(reused) }, 'Скриншот заказа распознан');
          return { ...await withStoredDocument(checked, { buffer, filename, mimeType }, request), readMs: Date.now() - started };
        } catch (error) {
          if (error instanceof Error && error.message.includes("OPENAI_API_KEY")) throw new ImportJobError("OpenAI ещё не настроен для импорта скриншотов.", 503);
          request.log.error({ err: error }, "Не удалось распознать скриншот заказа");
          throw new ImportJobError("Не удалось прочитать скриншот. Проверьте файл и повторите попытку.", 502);
        }
      }, () => { activeOrderImports -= 1; });
      return answerImportJob(job, reply);
    } finally {
      if (!handedOff) activeOrderImports -= 1;
    }
  });

  /** The page asks here while an Auftrag is still being read; only the session that uploaded it gets the result. */
  app.get("/imports/jobs/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const state = importJobs.get(id, importOwner(request));
    if (!state) return reply.status(404).send({ error: "Разбор не найден — возможно, он давно завершён. Загрузите файл заново." });
    if (state.status === "failed") return reply.status(state.statusCode).send({ error: state.error });
    if (state.status === "running") return reply.status(202).send({ status: "running", startedAt: new Date(state.startedAt).toISOString() });
    return { status: "done", preview: state.result };
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

  app.patch("/vehicles/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const patch = vehicleSchema.partial().strict().parse(request.body);
    if (!Object.keys(patch).length) return reply.status(400).send({ error: "Нечего менять." });
    const result = await vehicleService.update(id, patch);
    await audit(request, 'VEHICLE_UPDATED', 'Vehicle', id, { vehicleId: id, metadata: { before: result.before, after: result.after } });
    return toIsoObject(result.vehicle);
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

  app.post("/geocode/resolve", { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const input = z.object({
      address: z.string().trim().min(1).max(2000),
      city: z.string().trim().max(300).nullable().optional(),
      company: z.string().trim().max(300).nullable().optional()
    }).parse(request.body);
    const result = await resolveAddressWithFallback(routingService, input, addressResearcher, await addressRules.all(), await knownPlaces.all().catch(() => []), addressSources);
    return { address: result.resolvedAddress, ...result };
  });

  app.get("/tours", async (request) => {
    const query = z.object({ vehicleId: z.string().optional(), status: z.string().optional() }).parse(request.query);
    return (await enrichToursWithScheduleGroupedByVehicle(await findToursForList(prisma, query))).map(withoutDrawnRoute);
  });

  app.post("/tours", async (request, reply) => {
    const input = createTourSchema.parse(request.body);
    const tour = await tourService.createTour(input, auditActor(request));
    await rememberAddresses(tour.id, request);
    return reply.status(201).send(await enrichTourLive(tour));
  });

  app.post("/imports/tours/confirm", { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { importAttemptId, importFingerprint, documentId, ...input } = confirmImportedTourSchema.parse(request.body);
    const customerId = documentId ? (await orderDocuments.get(documentId).catch(() => null))?.customerId ?? null : null;
    const result = await tourService.createImportedTour({ ...input, customerId }, { importAttemptId, importFingerprint }, auditActor(request));
    if (result.created) {
      // With the stored preview the server learns from the real diff; without it the client's learnLabel still counts.
      if (documentId) await attachDocument(documentId, result.tour.id, input.vehicleId, input, request);
      else await learnAddressRules(input.stops, auditActor(request));
      await rememberAddresses(result.tour.id, request);
    }
    return reply.status(result.created ? 201 : 200).send({
      tour: await enrichTourLive(await withDocument(result.tour)),
      created: result.created,
      reused: !result.created
    });
  });

  app.post("/tours/with-new-vehicle", async (request, reply) => {
    const input = z.object({
      vehicle: z.object({ vehicleNumber: z.string().trim().min(1).max(100), licensePlate: z.string().trim().max(100).optional() }),
      tour: createTourSchema.omit({ vehicleId: true }).extend({ documentId: documentIdSchema })
    }).parse(request.body);
    const { documentId, ...tourInput } = input.tour;
    const customerId = documentId ? (await orderDocuments.get(documentId).catch(() => null))?.customerId ?? null : null;
    const result = await tourService.createTourForNewVehicle({ vehicle: input.vehicle, tour: { ...tourInput, customerId } }, auditActor(request));
    if (documentId) await attachDocument(documentId, result.tour.id, result.vehicle.id, tourInput, request);
    else await learnAddressRules(tourInput.stops, auditActor(request));
    await rememberAddresses(result.tour.id, request);
    return reply.status(201).send({ vehicle: toIsoObject(result.vehicle), tour: await enrichTourLive(await withDocument(result.tour)) });
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
    const now = new Date();
    // On the driver's tachograph when Webfleet has it; otherwise the calculated clock, preliminary.
    const driver = vehicle ? await driverBudget(vehicle.id, now) : null;
    const forecast = origin && vehicle
      ? driver ? forecastEta(new WebfleetEngine(driver.budget), durationSeconds, now, null, driver.startsAt)
        : { ...forecastDrive(forecastClock(parseClockState(vehicle.clockState, now), now), durationSeconds, now), plan: null }
      : null;
    return {
      distanceMeters: route.distanceMeters,
      durationSeconds,
      estimatedArrivalAt: forecast ? new Date(forecast.endAt).toISOString() : null,
      preliminary: !origin || (driver ? false : !vehicle?.clockState),
      etaPlan: forecast?.plan ?? null,
      geometry: route.geometry.map((point) => [point.longitude, point.latitude])
    };
  });

  app.get("/tours/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const tour = await prisma.tour.findUniqueOrThrow({ where: { id }, include: tourInclude });
    return enrichTourLive(tour);
  });

  app.patch("/tours/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = patchTourSchema.parse(request.body);
    const tour = "status" in body
      ? await tourService.cancelTour(id, body.version, new Date(), auditActor(request))
      : await tourService.updateFutureTour(id, body, auditActor(request));
    if (!("status" in body)) await rememberAddresses(tour.id, request);
    await refreshAlertsForVehicle(tour.vehicleId);
    return enrichTourLive(tour);
  });

  /**
   * Arrival comes from the GPS zone. Without fresh GPS the dispatcher's BELADEN/ENTLADEN records it too;
   * with fresh GPS outside the zone the event waits for the truck.
   */
  async function stopEventArrival(stopId: string, manual = false) {
    const stop = await prisma.stop.findUniqueOrThrow({ where: { id: stopId }, include: { tour: { select: { vehicleId: true } } } });
    if (stop.arrivedAt) return { arriveWithEvent: false };
    const gps = await webfleetTelemetry.latest(stop.tour.vehicleId);
    // «Вручную»: GPS missed the stop (no poll, wrong zone), the dispatcher knows the truck was there. Recorded as such.
    if (gps && !gps.stale && !manual) {
      const distance = distanceMeters(gps.latitude, gps.longitude, stop.latitude, stop.longitude);
      const radius = stop.arrivalRadiusMeters ?? DEFAULT_ARRIVAL_RADIUS_METERS;
      if (distance > radius) throw Object.assign(new Error(`По GPS машина ещё не в зоне точки (${(distance / 1000).toFixed(1)} км). Прибытие поставится само.`), { statusCode: 409 });
    }
    return { arriveWithEvent: true, manual: manual && Boolean(gps && !gps.stale) };
  }
  const stopEventBody = z.object({ timestamp: z.string().datetime().optional(), note: z.string().max(2000).optional(), manual: z.boolean().optional() });
  const manualNote = (note: string | undefined, arrival: { manual?: boolean }) =>
    arrival.manual ? [note, "Отмечено диспетчером вручную: прибытие по GPS не зафиксировано"].filter(Boolean).join(" · ") : note;

  app.post("/stops/:id/loaded", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = stopEventBody.parse(request.body ?? {});
    const arrival = await stopEventArrival(id, body.manual);
    const tour = await tourService.recordLoaded(id, body.timestamp ? new Date(body.timestamp) : new Date(), manualNote(body.note, arrival), auditActor(request), arrival);
    if (arrival.manual) await audit(request, 'STOP_EVENT_WITHOUT_GPS', 'Stop', id, { vehicleId: tour.vehicleId, tourId: tour.id, stopId: id, metadata: { event: 'LOADED' } });
    await refreshAlertsForVehicle(tour.vehicleId);
    return enrichTourLive(tour);
  });

  app.post("/stops/:id/unloaded", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = stopEventBody.parse(request.body ?? {});
    const arrival = await stopEventArrival(id, body.manual);
    const tour = await tourService.recordUnloaded(id, body.timestamp ? new Date(body.timestamp) : new Date(), manualNote(body.note, arrival), auditActor(request), arrival);
    if (arrival.manual) await audit(request, 'STOP_EVENT_WITHOUT_GPS', 'Stop', id, { vehicleId: tour.vehicleId, tourId: tour.id, stopId: id, metadata: { event: 'UNLOADED' } });
    await refreshAlertsForVehicle(tour.vehicleId);
    return enrichTourLive(tour);
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
  // Dispatchers connect their own trucks too (owner decision 2026-11-06); only the fleet presets and accounts stay admin.
  app.post('/integrations/webfleet/sync', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async (request) => {
    await webfleetSync.refreshIfDue();
    await audit(request, 'WEBFLEET_SYNC_REQUESTED', 'Integration', 'webfleet');
    return webfleetSync.status();
  });
  app.get('/integrations/webfleet/bindings', async () => listWebfleetBindings(prisma));
  app.post('/integrations/webfleet/bindings', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async (request) => {
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
  app.delete('/integrations/webfleet/bindings/:vehicleId', { preHandler: requireDispatcherRoles('admin', 'dispatcher') }, async (request) => {
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
    const tours = vehicle.tours.map((tour) => ({ ...tour, stops: withTerminGroups(tour.stops) }));
    const items = tours.flatMap((tour) => buildTimelineItems(tour));
    return {
      vehicle: toIsoObject(vehicle),
      tours: tours.map(toIsoObject),
      items,
      disclaimer: CALCULATED_POSITION_DISCLAIMER,
      schedule: schedule.map(toIsoObject),
      chain: tours.flatMap((tour) =>
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
      tours: await enrichToursWithScheduleGroupedByVehicle(tours),
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
    const myLines = new Set(await customerService.linesOf(me));
    const vehicles = await prisma.vehicle.findMany({
      include: {
        assignedDispatcher: { select: { id: true, displayName: true } },
        customerLine: { select: { id: true, code: true, name: true, customer: { select: { id: true, name: true, slug: true, color: true } } } },
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
      const [latestTelemetry, lastOperation, driver] = await Promise.all([
        webfleetTelemetry.latest(vehicle.id, generatedAt),
        prisma.operationEvent.findFirst({ where: { vehicleId: vehicle.id }, orderBy: { createdAt: "desc" } }),
        driverBudget(vehicle.id, generatedAt)
      ]);
      const calculatedPosition = await tourService.getCurrentPosition(vehicle.id, generatedAt, gpsFixOf(latestTelemetry), driver);
      const position = withWebfleetPosition(calculatedPosition, latestTelemetry);
      const currentStop = activeTour?.stops.find((stop) => !stop.completedAt) ?? null;
      const scheduledStop = currentStop ? etaService.calculateVehicleSchedule(vehicle.tours, generatedAt, driver).find((stop) => stop.stopId === currentStop.id) : null;
      // With fresh GPS the ETA is measured from the truck; the saved plan only fills in when there is no GPS.
      const gpsEta = position.etaSource === "GPS";
      // At the stop the truck is no longer late: the arrival settled it (TERMIN_MET says on time or how late).
      const arrived = Boolean(currentStop?.arrivedAt);
      const displayedEta = arrived ? currentStop!.arrivedAt!.toISOString() : position.eta ?? scheduledStop?.predictedEta?.toISOString() ?? null;
      const displayedDelayMinutes = arrived ? 0 : gpsEta ? position.delayMinutes : scheduledStop?.predictedDelayMinutes ?? position.delayMinutes;
      const riskColor = arrived ? "GREEN" : gpsEta ? calculateRiskColor(displayedEta ? new Date(displayedEta) : null, currentStop?.appointmentAt)
        : scheduledStop?.riskColor ?? calculateRiskColor(displayedEta ? new Date(displayedEta) : null, currentStop?.appointmentAt);
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
          // Without fresh GPS nothing can set the arrival: BELADEN/ENTLADEN records it together with the event.
          : currentStop && position.status === "ARRIVED" && !(latestTelemetry && !latestTelemetry.stale)
            ? {
                type: currentStop.type === "LOAD" ? "MARK_LOADED" : "MARK_UNLOADED",
                label: currentStop.type === "LOAD" ? "BELADEN" : "ENTLADEN",
                stopId: currentStop.id,
                withoutGpsArrival: true
              }
            // GPS is fresh but never saw the truck at the stop (no poll at that moment, wrong zone): the dispatcher
            // may still record BELADEN/ENTLADEN by hand; it is marked «вручную» and is not an alarm.
            : currentStop && !breakdown
              ? {
                  type: currentStop.type === "LOAD" ? "MARK_LOADED" : "MARK_UNLOADED",
                  label: currentStop.type === "LOAD" ? "BELADEN" : "ENTLADEN",
                  stopId: currentStop.id,
                  withoutGpsArrival: true,
                  manual: true
                }
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
        // «Мои»: taken by me, or on one of my lines and not taken by a colleague.
        mine: isMine(me, vehicle, myLines),
        customer: vehicle.customerLine ? { id: vehicle.customerLine.customer.id, name: vehicle.customerLine.customer.name, slug: vehicle.customerLine.customer.slug, color: vehicle.customerLine.customer.color } : null,
        line: vehicle.customerLine ? { id: vehicle.customerLine.id, code: vehicle.customerLine.code, name: vehicle.customerLine.name } : null,
        tour: activeTour ? toDashboardTourSummary(activeTour) : null,
        statusText: position.status,
        etaSource: position.etaSource ?? "CALCULATED",
        etaPlan: position.etaPlan ?? null,
        offRouteMeters: position.offRouteMeters ?? null,
        predictedArrival: position.predictedArrival ?? false,
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
        dwellSeverity: restAtStop.restAt(vehicle.id)?.stopId === currentStop?.id ? "NONE" : dwell.dwellSeverity,
        restAtStop: (() => { const rest = restAtStop.restAt(vehicle.id); return rest && rest.stopId === currentStop?.id ? rest : null; })(),
        stopActivity: (() => { const activity = restAtStop.activityAt(vehicle.id); return activity && activity.stopId === currentStop?.id ? activity : null; })(),
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
          lastContactAt: latestTelemetry.lastContactAt?.toISOString() ?? null,
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

async function enrichToursWithSchedule(tours: TourAggregate[]) {
  const now = new Date();
  const driver = tours[0] ? await driverBudget(tours[0].vehicleId, now) : null;
  const schedule = etaService.calculateVehicleSchedule(tours, now, driver);
  const scheduleByTour = new Map<string, (typeof schedule)[number]>();
  for (const item of schedule) {
    scheduleByTour.set(item.tourId, item);
  }

  return tours.map((tour) => {
    const enriched = enrichTour(tour, now, driver);
    const item = scheduleByTour.get(tour.id);
    return {
      ...enriched,
      predictedEta: item?.predictedEta?.toISOString() ?? enriched.currentEta,
      predictedDelayMinutes: item?.predictedDelayMinutes ?? enriched.currentDelayMinutes
    };
  });
}

async function enrichToursWithScheduleGroupedByVehicle(tours: TourAggregate[]) {
  const byVehicle = new Map<string, TourAggregate[]>();
  for (const tour of tours) {
    const group = byVehicle.get(tour.vehicleId) ?? [];
    group.push(tour);
    byVehicle.set(tour.vehicleId, group);
  }

  const enrichedById = new Map<string, Awaited<ReturnType<typeof enrichToursWithSchedule>>[number]>();
  for (const group of byVehicle.values()) {
    for (const tour of await enrichToursWithSchedule(group)) {
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

/** Only a fresh Webfleet position may move the truck along its route; a stale one is shown but not trusted. */
function gpsFixOf(telemetry: Awaited<ReturnType<WebfleetTelemetryService['latest']>>): GpsFix | null {
  if (!telemetry || !telemetry.usable) return null;
  return { latitude: telemetry.latitude, longitude: telemetry.longitude, fresh: !telemetry.stale };
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
