ALTER TABLE "Tour" ADD COLUMN "importAttemptId" TEXT;
ALTER TABLE "Tour" ADD COLUMN "importFingerprint" TEXT;

ALTER TABLE "Stop" ADD COLUMN "sourceAddress" TEXT;
ALTER TABLE "Stop" ADD COLUMN "resolvedAddress" TEXT;
ALTER TABLE "Stop" ADD COLUMN "geocodePrecision" TEXT;
ALTER TABLE "Stop" ADD COLUMN "geocodeProvider" TEXT;

CREATE UNIQUE INDEX "Tour_importAttemptId_key" ON "Tour"("importAttemptId");
CREATE UNIQUE INDEX "Tour_importFingerprint_key" ON "Tour"("importFingerprint");
