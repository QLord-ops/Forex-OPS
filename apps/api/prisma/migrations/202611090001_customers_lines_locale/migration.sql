-- Customers (Schnellecke, Walter …) with their lines, the dispatchers' lines, the customer of a tour, an Auftrag
-- and an import correction, import rules per customer, the interface language of a dispatcher and notification
-- parameters for translated texts (owner decisions 2026-11-08).
-- Additive only: new tables and nullable columns; the ImportRule unique key gains a scope column whose default
-- 'global' keeps every existing rule as it is. No existing row changes; customers are created later by an admin action.

CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "aliasesJson" TEXT NOT NULL DEFAULT '[]',
    "color" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "profileJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Customer_slug_key" ON "Customer"("slug");

CREATE TABLE "CustomerLine" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentCompany" TEXT,
    "departmentAddress" TEXT,
    "departmentCity" TEXT,
    "sortIndex" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerLine_customerId_code_key" ON "CustomerLine"("customerId", "code");
ALTER TABLE "CustomerLine" ADD CONSTRAINT "CustomerLine_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DispatcherLine" (
    "dispatcherId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatcherLine_pkey" PRIMARY KEY ("dispatcherId", "lineId")
);
CREATE INDEX "DispatcherLine_lineId_idx" ON "DispatcherLine"("lineId");
ALTER TABLE "DispatcherLine" ADD CONSTRAINT "DispatcherLine_dispatcherId_fkey" FOREIGN KEY ("dispatcherId") REFERENCES "Dispatcher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DispatcherLine" ADD CONSTRAINT "DispatcherLine_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "CustomerLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Vehicle" ADD COLUMN "customerLineId" TEXT;
CREATE INDEX "Vehicle_customerLineId_idx" ON "Vehicle"("customerLineId");
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_customerLineId_fkey" FOREIGN KEY ("customerLineId") REFERENCES "CustomerLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Tour" ADD COLUMN "customerId" TEXT;
ALTER TABLE "Tour" ADD COLUMN "customerLineId" TEXT;
CREATE INDEX "Tour_customerId_status_idx" ON "Tour"("customerId", "status");
CREATE INDEX "Tour_customerLineId_idx" ON "Tour"("customerLineId");
ALTER TABLE "Tour" ADD CONSTRAINT "Tour_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Tour" ADD CONSTRAINT "Tour_customerLineId_fkey" FOREIGN KEY ("customerLineId") REFERENCES "CustomerLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderDocument" ADD COLUMN "customerId" TEXT;
CREATE INDEX "OrderDocument_customerId_createdAt_idx" ON "OrderDocument"("customerId", "createdAt");

ALTER TABLE "ImportCorrection" ADD COLUMN "customerId" TEXT;
CREATE INDEX "ImportCorrection_customerId_createdAt_idx" ON "ImportCorrection"("customerId", "createdAt");

ALTER TABLE "ImportRule" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'global';
DROP INDEX "ImportRule_kind_pattern_key";
CREATE UNIQUE INDEX "ImportRule_scope_kind_pattern_key" ON "ImportRule"("scope", "kind", "pattern");

ALTER TABLE "DailyStatusReport" ADD COLUMN "customerId" TEXT;
ALTER TABLE "Dispatcher" ADD COLUMN "locale" TEXT;
ALTER TABLE "Notification" ADD COLUMN "paramsJson" TEXT;
