CREATE TABLE "Vehicle" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vehicleNumber" TEXT NOT NULL,
  "licensePlate" TEXT,
  "maxSpeedKmh" INTEGER NOT NULL DEFAULT 85,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Vehicle_vehicleNumber_key" ON "Vehicle"("vehicleNumber");

CREATE TABLE "Tour" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vehicleId" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL,
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
CREATE INDEX "Tour_vehicleId_status_idx" ON "Tour"("vehicleId", "status");
CREATE INDEX "Tour_previousTourId_idx" ON "Tour"("previousTourId");

CREATE TABLE "Stop" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tourId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "company" TEXT,
  "address" TEXT NOT NULL,
  "latitude" REAL NOT NULL,
  "longitude" REAL NOT NULL,
  "appointmentAt" DATETIME NOT NULL,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Stop_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Stop_tourId_sequence_key" ON "Stop"("tourId", "sequence");
CREATE INDEX "Stop_tourId_sequence_idx" ON "Stop"("tourId", "sequence");

CREATE TABLE "Leg" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tourId" TEXT NOT NULL,
  "fromStopId" TEXT NOT NULL,
  "toStopId" TEXT NOT NULL,
  "distanceMeters" INTEGER NOT NULL,
  "routeGeometry" TEXT NOT NULL,
  "routingDurationSeconds" INTEGER NOT NULL,
  "simulatedDurationSeconds" INTEGER NOT NULL,
  "startedAt" DATETIME,
  "finishedAt" DATETIME,
  "status" TEXT NOT NULL DEFAULT 'WAITING',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Leg_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Leg_fromStopId_fkey" FOREIGN KEY ("fromStopId") REFERENCES "Stop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Leg_toStopId_fkey" FOREIGN KEY ("toStopId") REFERENCES "Stop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Leg_tourId_status_idx" ON "Leg"("tourId", "status");

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
CREATE INDEX "Event_vehicleId_timestamp_idx" ON "Event"("vehicleId", "timestamp");
CREATE INDEX "Event_tourId_timestamp_idx" ON "Event"("tourId", "timestamp");

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
CREATE UNIQUE INDEX "Alert_stopId_type_key" ON "Alert"("stopId", "type");
CREATE INDEX "Alert_vehicleId_resolvedAt_idx" ON "Alert"("vehicleId", "resolvedAt");
