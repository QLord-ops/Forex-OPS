import type { Prisma, PrismaClient } from "@prisma/client";

export type AuditActor = {
  // "system" marks automatic actions such as a GPS arrival from Webfleet.
  role: "admin" | "dispatcher" | "system";
  sessionId: string;
};

type AuditDatabase = PrismaClient | Prisma.TransactionClient;

export async function writeAuditLog(
  db: AuditDatabase,
  actor: AuditActor | undefined,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    vehicleId?: string | null;
    tourId?: string | null;
    stopId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: Date;
  },
): Promise<void> {
  if (!actor) return;
  await db.auditLog.create({
    data: {
      actorRole: actor.role,
      actorSessionId: actor.sessionId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      vehicleId: input.vehicleId ?? null,
      tourId: input.tourId ?? null,
      stopId: input.stopId ?? null,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: input.createdAt,
    },
  });
}
