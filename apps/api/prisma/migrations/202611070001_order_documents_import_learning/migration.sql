-- Auftrag documents kept with their tour, dispatcher corrections of the AI import and the rules learned from them,
-- plus the onboarding mark of a dispatcher account (owner decisions 2026-11-06).
-- Additive only: new tables and one nullable column; no existing row changes.

ALTER TABLE "Dispatcher" ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);

-- The uploaded Auftrag with what the AI read and what the dispatcher saved. Bytes are read only by the file route.
CREATE TABLE "OrderDocument" (
    "id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "previewJson" TEXT NOT NULL,
    "confirmedJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "uploadedByDispatcherId" TEXT,
    "vehicleId" TEXT,
    "tourId" TEXT,
    "attachedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrderDocument_sha256_key" ON "OrderDocument"("sha256");
CREATE UNIQUE INDEX "OrderDocument_tourId_key" ON "OrderDocument"("tourId");
CREATE INDEX "OrderDocument_status_createdAt_idx" ON "OrderDocument"("status", "createdAt");
CREATE INDEX "OrderDocument_vehicleId_createdAt_idx" ON "OrderDocument"("vehicleId", "createdAt");
ALTER TABLE "OrderDocument" ADD CONSTRAINT "OrderDocument_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One dispatcher correction of an AI-read stop. Never updated or deleted.
CREATE TABLE "ImportCorrection" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "tourId" TEXT,
    "dispatcherId" TEXT,
    "kind" TEXT NOT NULL,
    "field" TEXT,
    "aiValue" TEXT,
    "finalValue" TEXT,
    "contextJson" TEXT,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportCorrection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ImportCorrection_signature_createdAt_idx" ON "ImportCorrection"("signature", "createdAt");
CREATE INDEX "ImportCorrection_documentId_idx" ON "ImportCorrection"("documentId");
CREATE INDEX "ImportCorrection_tourId_idx" ON "ImportCorrection"("tourId");
ALTER TABLE "ImportCorrection" ADD CONSTRAINT "ImportCorrection_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OrderDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rule learned from repeated corrections: alias, ignored label or stop type. Active once the threshold is reached.
CREATE TABLE "ImportRule" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "value" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ImportRule_kind_pattern_key" ON "ImportRule"("kind", "pattern");
