import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireDispatcherRoles } from '../services/dispatcher-auth.js';
import type { AppointmentService } from '../services/appointments.js';
import { appointmentTime, matchAppointment } from '../services/appointment-match.js';
import type { AppointmentDocument } from '../services/pdf-order-import.js';
import type { PendingAppointmentService } from '../services/pending-appointments.js';

type Audit = (request: FastifyRequest, action: string, entityType: string, entityId: string,
  extra?: { vehicleId?: string | null; tourId?: string | null; stopId?: string | null; metadata?: Record<string, unknown> }) => Promise<void>;

const local = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable();
/** The recognised slip as the review card sends it back, possibly corrected by the dispatcher. */
const documentSchema = z.object({
  kind: z.enum(['VW_FAHRTENSCHEIN', 'DECKBLATT', 'OTHER']),
  documentType: z.string().trim().max(200).nullable().default(null),
  plate: z.string().trim().max(40).nullable().default(null),
  trailerPlate: z.string().trim().max(40).nullable().default(null),
  company: z.string().trim().max(300).nullable().default(null),
  site: z.string().trim().max(300).nullable().default(null),
  city: z.string().trim().max(200).nullable().default(null),
  stopType: z.enum(['LOAD', 'UNLOAD']).nullable().default(null),
  appointmentLocal: local.default(null),
  windowStartLocal: local.default(null),
  windowEndLocal: local.default(null),
  references: z.array(z.object({ label: z.string().trim().max(80), value: z.string().trim().min(1).max(120) })).max(15).default([]),
  sourceExcerpt: z.string().trim().max(1000).nullable().default(null)
}).refine((value) => Boolean(value.appointmentLocal) || Boolean(value.windowStartLocal && value.windowEndLocal), 'Укажите время термина или окно.');
const fingerprint = z.string().regex(/^termin-[0-9a-f]{64}$/);

function asDocument(input: z.infer<typeof documentSchema>): AppointmentDocument {
  return { ...input, standgeldFromLocal: null, positions: [], confidence: 1, warnings: [] };
}

export function registerAppointmentDocumentRoutes(app: FastifyInstance, deps: {
  prisma: PrismaClient; appointments: AppointmentService; pending: PendingAppointmentService; audit: Audit;
  refreshAlertsForVehicle: (vehicleId: string) => Promise<unknown>;
}) {
  const { prisma, appointments, pending, audit } = deps;
  const editors = { preHandler: requireDispatcherRoles('admin', 'dispatcher') };

  /** Re-run the match after the dispatcher corrected the plate, place or time in the review card. */
  app.post('/appointments/match', editors, async (request) => {
    const document = asDocument(documentSchema.parse(request.body));
    return matchAppointment(prisma, document);
  });

  /** Apply a recognised slip to one stop: exact time or window, plus its reference numbers. */
  app.post('/appointments/from-document', editors, async (request) => {
    const input = z.object({
      stopId: z.string().min(1).max(64), version: z.number().int().nonnegative(), fingerprint,
      pendingId: z.string().min(1).max(64).nullable().default(null), document: documentSchema, scope: z.enum(['PLACE', 'STOP']).optional()
    }).parse(request.body);
    const previous = await pending.findByFingerprint(input.fingerprint);
    if (previous?.status === 'ATTACHED') {
      const stop = previous.attachedStopId ? await prisma.stop.findUnique({ where: { id: previous.attachedStopId }, include: { tour: { include: { vehicle: true } } } }) : null;
      throw Object.assign(new Error(`Этот термин уже применён${stop ? ` к LKW ${stop.tour.vehicle.vehicleNumber}` : ''}.`), { statusCode: 409 });
    }
    const document = asDocument(input.document);
    const parsed = appointmentTime(document);
    const time = {
      appointmentAt: parsed.appointmentAt?.toISOString() ?? null,
      windowStartAt: parsed.appointmentAt ? null : parsed.windowStartAt?.toISOString() ?? null,
      windowEndAt: parsed.appointmentAt ? null : parsed.windowEndAt?.toISOString() ?? null
    };
    const label = document.documentType ?? (document.kind === 'VW_FAHRTENSCHEIN' ? 'Fahrtenschein' : document.kind === 'DECKBLATT' ? 'Deckblatt' : 'Termin');
    const analysis = await appointments.apply(input.stopId, { ...time, version: input.version }, new Date(), {
      source: 'DOCUMENT', references: document.references.map((item) => item.value), document: { kind: document.kind, label }, scope: input.scope
    });
    // A slip for the second operation of a place lands on the stop that keeps the Termin of the place.
    const stopId = analysis.appliedToStopId;
    if (input.pendingId) await pending.attach(input.pendingId, stopId);
    await pending.save(document, input.fingerprint, 'ATTACHED', { vehicleId: analysis.vehicleId, attachedStopId: stopId });
    await audit(request, 'STOP_APPOINTMENT_SET', 'Stop', stopId, { vehicleId: analysis.vehicleId, tourId: analysis.tourId, stopId,
      metadata: { ...time, source: 'DOCUMENT', documentKind: document.kind, references: document.references.map((item) => item.value),
        requestedStopId: input.stopId, sharedStopIds: analysis.sharedStopIds } });
    await deps.refreshAlertsForVehicle(analysis.vehicleId);
    return analysis;
  });

  /** Keep a slip that arrived before its Auftrag; it is offered again when a matching stop appears. */
  app.post('/appointments/pending', editors, async (request) => {
    const input = z.object({ fingerprint, document: documentSchema }).parse(request.body);
    const document = asDocument(input.document);
    const match = await matchAppointment(prisma, document);
    const row = await pending.save(document, input.fingerprint, 'PENDING', { vehicleId: match.vehicle.status === 'MATCHED' ? match.vehicle.vehicleId : null });
    await audit(request, 'APPOINTMENT_PENDING_SAVED', 'PendingAppointment', row.id, { metadata: { documentKind: document.kind, company: document.company, city: document.city } });
    return { id: row.id, status: row.status };
  });

  app.get('/appointments/pending', async () => ({ items: await pending.list() }));

  app.post('/appointments/pending/:id/dismiss', editors, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const result = await pending.dismiss(id);
    await audit(request, 'APPOINTMENT_PENDING_DISMISSED', 'PendingAppointment', id);
    return result;
  });
}
