CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleNumber" TEXT NOT NULL,
    "licensePlate" TEXT,
    "maxSpeedKmh" INTEGER NOT NULL DEFAULT 85,
    "clockState" TEXT,
    "manualStoppedAt" DATETIME,
    "operationVersion" INTEGER NOT NULL DEFAULT 0,
    "truckProfile" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "Tour" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL DEFAULT 0,
    "queueIndex" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "previousTourId" TEXT,
    "plannedStartAt" DATETIME,
    "actualStartAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tour_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Tour_previousTourId_fkey" FOREIGN KEY ("previousTourId") REFERENCES "Tour" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE TABLE "Stop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tourId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "company" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "appointmentAt" DATETIME,
    "arrivedAt" DATETIME,
    "serviceMinMinutes" INTEGER NOT NULL DEFAULT 60,
    "serviceMaxMinutes" INTEGER NOT NULL DEFAULT 120,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Stop_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Leg" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tourId" TEXT NOT NULL,
    "fromStopId" TEXT NOT NULL,
    "toStopId" TEXT NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "routeGeometry" TEXT NOT NULL,
    "routingDurationSeconds" INTEGER NOT NULL,
    "simulatedDurationSeconds" INTEGER NOT NULL,
    "drivePlan" TEXT,
    "routeDetails" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Leg_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Leg_fromStopId_fkey" FOREIGN KEY ("fromStopId") REFERENCES "Stop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Leg_toStopId_fkey" FOREIGN KEY ("toStopId") REFERENCES "Stop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "note" TEXT,
    CONSTRAINT "Event_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Event_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Event_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "Stop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "appointmentAt" DATETIME NOT NULL,
    "predictedEta" DATETIME NOT NULL,
    "predictedLateMinutes" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "Alert_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Alert_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Alert_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "Stop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "ApiQuota" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "OperationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "tourId" TEXT,
    "stopId" TEXT,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dedupKey" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "stopId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" DATETIME
);
CREATE TABLE "RouteRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tourId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "RoutePreview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tourId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "vehicleVersion" INTEGER NOT NULL,
    "inputJson" TEXT NOT NULL,
    "planJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "appliedAt" DATETIME
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
