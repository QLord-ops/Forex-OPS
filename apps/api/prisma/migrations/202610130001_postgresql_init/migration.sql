-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "vehicleNumber" TEXT NOT NULL,
    "licensePlate" TEXT,
    "maxSpeedKmh" INTEGER NOT NULL DEFAULT 85,
    "clockState" TEXT,
    "manualStoppedAt" TIMESTAMP(3),
    "operationVersion" INTEGER NOT NULL DEFAULT 0,
    "truckProfile" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tour" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL DEFAULT 0,
    "queueIndex" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "previousTourId" TEXT,
    "plannedStartAt" TIMESTAMP(3),
    "actualStartAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Tour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stop" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "company" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "appointmentAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "serviceMinMinutes" INTEGER NOT NULL DEFAULT 60,
    "serviceMaxMinutes" INTEGER NOT NULL DEFAULT 120,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Stop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Leg" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "fromStopId" TEXT NOT NULL,
    "toStopId" TEXT NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "routeGeometry" TEXT NOT NULL,
    "routingDurationSeconds" INTEGER NOT NULL,
    "simulatedDurationSeconds" INTEGER NOT NULL,
    "drivePlan" TEXT,
    "routeDetails" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Leg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "appointmentAt" TIMESTAMP(3) NOT NULL,
    "predictedEta" TIMESTAMP(3) NOT NULL,
    "predictedLateMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiQuota" (
    "id" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApiQuota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationEvent" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "tourId" TEXT,
    "stopId" TEXT,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OperationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "stopId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteRevision" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RouteRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutePreview" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "vehicleVersion" INTEGER NOT NULL,
    "inputJson" TEXT NOT NULL,
    "planJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),
    CONSTRAINT "RoutePreview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Vehicle_vehicleNumber_key" ON "Vehicle"("vehicleNumber");
CREATE INDEX "Tour_vehicleId_status_idx" ON "Tour"("vehicleId", "status");
CREATE INDEX "Tour_previousTourId_idx" ON "Tour"("previousTourId");
CREATE INDEX "Stop_tourId_sequence_idx" ON "Stop"("tourId", "sequence");
CREATE UNIQUE INDEX "Stop_tourId_sequence_key" ON "Stop"("tourId", "sequence");
CREATE INDEX "Leg_tourId_status_idx" ON "Leg"("tourId", "status");
CREATE INDEX "Event_vehicleId_timestamp_idx" ON "Event"("vehicleId", "timestamp");
CREATE INDEX "Event_tourId_timestamp_idx" ON "Event"("tourId", "timestamp");
CREATE INDEX "Alert_vehicleId_resolvedAt_idx" ON "Alert"("vehicleId", "resolvedAt");
CREATE UNIQUE INDEX "Alert_stopId_type_key" ON "Alert"("stopId", "type");
CREATE INDEX "OperationEvent_vehicleId_createdAt_idx" ON "OperationEvent"("vehicleId", "createdAt");
CREATE UNIQUE INDEX "Notification_dedupKey_key" ON "Notification"("dedupKey");
CREATE INDEX "Notification_acknowledgedAt_createdAt_idx" ON "Notification"("acknowledgedAt", "createdAt");
CREATE INDEX "RouteRevision_tourId_version_idx" ON "RouteRevision"("tourId", "version");
CREATE INDEX "RoutePreview_tourId_createdAt_idx" ON "RoutePreview"("tourId", "createdAt");

ALTER TABLE "Tour" ADD CONSTRAINT "Tour_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Tour" ADD CONSTRAINT "Tour_previousTourId_fkey" FOREIGN KEY ("previousTourId") REFERENCES "Tour"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Stop" ADD CONSTRAINT "Stop_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Leg" ADD CONSTRAINT "Leg_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Leg" ADD CONSTRAINT "Leg_fromStopId_fkey" FOREIGN KEY ("fromStopId") REFERENCES "Stop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Leg" ADD CONSTRAINT "Leg_toStopId_fkey" FOREIGN KEY ("toStopId") REFERENCES "Stop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "Stop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "Stop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
