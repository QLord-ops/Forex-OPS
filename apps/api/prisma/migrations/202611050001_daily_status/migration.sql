-- Automatic 07:00 status list per customer line (owner decision 2026-11-05).
-- Additive only: no existing row changes and no data is filled in; the Schnellecke line is set later by an admin action.

-- Line and block of a truck in the status list, plus the truck's own service phone (never a driver's number).
ALTER TABLE "Vehicle" ADD COLUMN "line" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "statusGroup" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "servicePhone" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "aSchild" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Vehicle" ADD COLUMN "appSped" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Vehicle_line_statusGroup_idx" ON "Vehicle"("line", "statusGroup");

-- One list per line and Berlin day; the unique key is the lock against a double run.
CREATE TABLE "DailyStatusReport" (
    "id" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GENERATING',
    "preliminary" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3),
    "generatedByRole" TEXT NOT NULL,
    "generatedByDispatcherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyStatusReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DailyStatusReport_line_date_key" ON "DailyStatusReport"("line", "date");

-- One truck in a list: a snapshot with the dispatcher's edits. No driver name or id.
CREATE TABLE "DailyStatusRow" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "vehicleNumber" TEXT NOT NULL,
    "statusGroup" TEXT,
    "sortIndex" INTEGER NOT NULL,
    "rule" TEXT NOT NULL,
    "ort" TEXT,
    "ortSource" TEXT,
    "startAt" TIMESTAMP(3),
    "startKind" TEXT NOT NULL,
    "ziel" TEXT,
    "ankunftAt" TIMESTAMP(3),
    "ankunftKind" TEXT NOT NULL,
    "bemerkungAuto" TEXT,
    "bemerkung" TEXT,
    "overridesJson" TEXT,
    "weNortheim" TEXT,
    "trailer" TEXT,
    "trailerSource" TEXT,
    "servicePhone" TEXT,
    "aSchild" BOOLEAN NOT NULL DEFAULT false,
    "appSped" BOOLEAN NOT NULL DEFAULT false,
    "tourId" TEXT,
    "stopId" TEXT,
    "detailsJson" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "editedAt" TIMESTAMP(3),
    "editedByDispatcherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyStatusRow_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DailyStatusRow_reportId_vehicleId_key" ON "DailyStatusRow"("reportId", "vehicleId");
CREATE INDEX "DailyStatusRow_reportId_sortIndex_idx" ON "DailyStatusRow"("reportId", "sortIndex");
ALTER TABLE "DailyStatusRow" ADD CONSTRAINT "DailyStatusRow_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "DailyStatusReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyStatusRow" ADD CONSTRAINT "DailyStatusRow_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
