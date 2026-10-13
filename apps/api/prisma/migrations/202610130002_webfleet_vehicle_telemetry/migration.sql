CREATE TABLE "VehicleIntegration" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalNumber" TEXT,
    "externalPlate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleIntegration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VehicleTelemetry" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "speedKmh" DOUBLE PRECISION,
    "ignitionOn" BOOLEAN,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawJson" TEXT,

    CONSTRAINT "VehicleTelemetry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationSyncState" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "cursor" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "lastSnapshotAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSyncState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationReceipt" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "externalId" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "payloadJson" TEXT,

    CONSTRAINT "IntegrationReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VehicleIntegration_provider_externalId_key" ON "VehicleIntegration"("provider", "externalId");
CREATE UNIQUE INDEX "VehicleIntegration_provider_vehicleId_key" ON "VehicleIntegration"("provider", "vehicleId");
CREATE INDEX "VehicleIntegration_provider_externalNumber_idx" ON "VehicleIntegration"("provider", "externalNumber");
CREATE INDEX "VehicleIntegration_provider_externalPlate_idx" ON "VehicleIntegration"("provider", "externalPlate");
CREATE UNIQUE INDEX "VehicleTelemetry_provider_externalId_recordedAt_key" ON "VehicleTelemetry"("provider", "externalId", "recordedAt");
CREATE INDEX "VehicleTelemetry_vehicleId_recordedAt_idx" ON "VehicleTelemetry"("vehicleId", "recordedAt");
CREATE INDEX "IntegrationSyncState_provider_lockedUntil_idx" ON "IntegrationSyncState"("provider", "lockedUntil");
CREATE UNIQUE INDEX "IntegrationReceipt_provider_messageId_key" ON "IntegrationReceipt"("provider", "messageId");
CREATE INDEX "IntegrationReceipt_provider_acknowledgedAt_idx" ON "IntegrationReceipt"("provider", "acknowledgedAt");

ALTER TABLE "VehicleIntegration" ADD CONSTRAINT "VehicleIntegration_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleTelemetry" ADD CONSTRAINT "VehicleTelemetry_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
