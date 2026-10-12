-- Forward-only migration. Restore the pre-upgrade backup only with the old app.
-- SQLite requires a table copy to make appointmentAt nullable; no events are invented.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
ALTER TABLE "Vehicle" ADD COLUMN "clockState" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "manualStoppedAt" DATETIME;
ALTER TABLE "Vehicle" ADD COLUMN "operationVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Vehicle" ADD COLUMN "truckProfile" TEXT;
ALTER TABLE "Tour" ADD COLUMN "planVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Tour" ADD COLUMN "queueIndex" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Leg" ADD COLUMN "drivePlan" TEXT;
ALTER TABLE "Leg" ADD COLUMN "routeDetails" TEXT;
CREATE TABLE "new_Stop" (
 "id" TEXT NOT NULL PRIMARY KEY, "tourId" TEXT NOT NULL, "sequence" INTEGER NOT NULL,
 "type" TEXT NOT NULL, "company" TEXT, "address" TEXT NOT NULL, "city" TEXT,
 "latitude" REAL NOT NULL, "longitude" REAL NOT NULL, "appointmentAt" DATETIME,
 "arrivedAt" DATETIME, "serviceMinMinutes" INTEGER NOT NULL DEFAULT 60,
 "serviceMaxMinutes" INTEGER NOT NULL DEFAULT 120, "completedAt" DATETIME,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "Stop_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Stop" ("id","tourId","sequence","type","company","address","latitude","longitude","appointmentAt","completedAt","createdAt")
 SELECT "id","tourId","sequence","type","company","address","latitude","longitude","appointmentAt","completedAt","createdAt" FROM "Stop";
DROP TABLE "Stop";
ALTER TABLE "new_Stop" RENAME TO "Stop";
CREATE UNIQUE INDEX "Stop_tourId_sequence_key" ON "Stop"("tourId","sequence");
CREATE INDEX "Stop_tourId_sequence_idx" ON "Stop"("tourId","sequence");
CREATE TABLE "ApiQuota" ("id" TEXT NOT NULL PRIMARY KEY,"used" INTEGER NOT NULL DEFAULT 0,"updatedAt" DATETIME NOT NULL);
CREATE TABLE "OperationEvent" (
 "id" TEXT NOT NULL PRIMARY KEY,"vehicleId" TEXT NOT NULL,"tourId" TEXT,"stopId" TEXT,
 "type" TEXT NOT NULL,"payloadJson" TEXT NOT NULL,"reason" TEXT,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OperationEvent_vehicleId_createdAt_idx" ON "OperationEvent"("vehicleId","createdAt");
CREATE TABLE "Notification" (
 "id" TEXT NOT NULL PRIMARY KEY,"dedupKey" TEXT NOT NULL,"vehicleId" TEXT NOT NULL,"stopId" TEXT,
 "type" TEXT NOT NULL,"message" TEXT NOT NULL,"payloadJson" TEXT NOT NULL,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,"acknowledgedAt" DATETIME
);
CREATE UNIQUE INDEX "Notification_dedupKey_key" ON "Notification"("dedupKey");
CREATE INDEX "Notification_acknowledgedAt_createdAt_idx" ON "Notification"("acknowledgedAt","createdAt");
CREATE TABLE "RouteRevision" (
 "id" TEXT NOT NULL PRIMARY KEY,"tourId" TEXT NOT NULL,"version" INTEGER NOT NULL,
 "snapshotJson" TEXT NOT NULL,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "RouteRevision_tourId_version_idx" ON "RouteRevision"("tourId","version");
CREATE TABLE "RoutePreview" (
 "id" TEXT NOT NULL PRIMARY KEY,"tourId" TEXT NOT NULL,"version" INTEGER NOT NULL,"vehicleVersion" INTEGER NOT NULL,
 "inputJson" TEXT NOT NULL,"planJson" TEXT NOT NULL,"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" DATETIME NOT NULL,"appliedAt" DATETIME
);
CREATE INDEX "RoutePreview_tourId_createdAt_idx" ON "RoutePreview"("tourId","createdAt");
COMMIT;
PRAGMA foreign_keys=ON;
