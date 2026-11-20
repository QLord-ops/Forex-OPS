-- Driver app (owner, 17.11): the driver's own BELADEN/ENTLADEN is a real event and the dispatcher is only notified.
-- Additive only: one nullable column and one new table; no row is changed.

-- Who recorded the stop event: DISPATCHER | WEBFLEET_AUTO | DRIVER. NULL = recorded before the driver app.
ALTER TABLE "Event" ADD COLUMN "source" TEXT;

-- A shift code signs the driver app in for one truck until the shift ends. Bound to the truck, never to a person:
-- no driver name, phone or device data (DSGVO). Only the hash of the code is stored.
CREATE TABLE "DriverShift" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "firstUsedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedByDispatcherId" TEXT,
    "createdByDispatcherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverShift_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DriverShift_vehicleId_endsAt_idx" ON "DriverShift"("vehicleId", "endsAt");
ALTER TABLE "DriverShift" ADD CONSTRAINT "DriverShift_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
