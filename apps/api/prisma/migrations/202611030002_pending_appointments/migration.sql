-- Appointment slips (Termin) recognised before their tour exists. Additive only.
CREATE TABLE "PendingAppointment" (
    "id" TEXT NOT NULL,
    "documentKind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "vehiclePlate" TEXT,
    "vehicleId" TEXT,
    "company" TEXT,
    "site" TEXT,
    "city" TEXT,
    "stopType" TEXT,
    "appointmentAt" TIMESTAMP(3),
    "windowStartAt" TIMESTAMP(3),
    "windowEndAt" TIMESTAMP(3),
    "referencesJson" TEXT,
    "sourceExcerpt" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attachedStopId" TEXT,
    "createdByDispatcherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingAppointment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PendingAppointment_fingerprint_key" ON "PendingAppointment"("fingerprint");
CREATE INDEX "PendingAppointment_status_createdAt_idx" ON "PendingAppointment"("status", "createdAt");
CREATE INDEX "PendingAppointment_vehicleId_status_idx" ON "PendingAppointment"("vehicleId", "status");
