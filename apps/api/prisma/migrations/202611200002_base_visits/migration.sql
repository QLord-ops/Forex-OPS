-- Trucks that come home to the base in a given week, and the base itself as a setting.
-- Additive only: two new tables, no existing row or column changes.
CREATE TABLE "BaseVisit" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "freeAt" TIMESTAMP(3) NOT NULL,
    "arrivedAt" TIMESTAMP(3),
    "arrivedSource" TEXT,
    "arrivedByDispatcherId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByDispatcherId" TEXT,
    "createdByDispatcherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BaseVisit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BaseVisit_vehicleId_weekStart_key" ON "BaseVisit"("vehicleId", "weekStart");
CREATE INDEX "BaseVisit_weekStart_idx" ON "BaseVisit"("weekStart");
ALTER TABLE "BaseVisit" ADD CONSTRAINT "BaseVisit_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL,
    "updatedByDispatcherId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);
