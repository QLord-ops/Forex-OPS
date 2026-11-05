-- Saved addresses for address suggestions, read from the Webfleet address book (owner decision 2026-11-05).
-- Additive only: a new table, no existing row changes. Contacts, phones, e-mail and notes are not stored (DSGVO).
CREATE TABLE "KnownAddress" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalNumber" TEXT,
    "name" TEXT NOT NULL,
    "name2" TEXT,
    "street" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "country" TEXT,
    "region" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radiusMeters" INTEGER,
    "groups" TEXT,
    "searchText" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnownAddress_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnownAddress_source_externalId_key" ON "KnownAddress"("source", "externalId");
CREATE INDEX "KnownAddress_active_idx" ON "KnownAddress"("active");
