-- Address rules for Auftrag import (abbreviations, companies, sites learned from the dispatcher's corrections)
-- and planning fields of a stop. Additive only: no existing row changes.
CREATE TABLE "AddressRule" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "company" TEXT,
    "street" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "requiresTermin" BOOLEAN NOT NULL DEFAULT false,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdByDispatcherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddressRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AddressRule_pattern_key" ON "AddressRule"("pattern");

-- Planned time without a Termin (e.g. 06:00 on the delivery day), the latest departure from loading,
-- and whether the customer always sends a Termin that has not arrived yet.
ALTER TABLE "Stop" ADD COLUMN "plannedAt" TIMESTAMP(3);
ALTER TABLE "Stop" ADD COLUMN "departureDeadlineAt" TIMESTAMP(3);
ALTER TABLE "Stop" ADD COLUMN "terminRequired" BOOLEAN NOT NULL DEFAULT false;
