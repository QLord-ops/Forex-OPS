-- Additive fields: existing tours and vehicles keep their unknown values.
ALTER TABLE "Vehicle" ADD COLUMN "currentTrailerPlate" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "manualPositionAddress" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "manualPositionLatitude" DOUBLE PRECISION;
ALTER TABLE "Vehicle" ADD COLUMN "manualPositionLongitude" DOUBLE PRECISION;
ALTER TABLE "Vehicle" ADD COLUMN "manualPositionAt" TIMESTAMP(3);

ALTER TABLE "Tour" ADD COLUMN "trailerPlate" TEXT;
ALTER TABLE "Tour" ADD COLUMN "tourRemarks" TEXT;
ALTER TABLE "Tour" ADD COLUMN "approachDurationSeconds" INTEGER;
ALTER TABLE "Tour" ADD COLUMN "approachDistanceMeters" INTEGER;
ALTER TABLE "Tour" ADD COLUMN "approachGeometry" TEXT;

ALTER TABLE "Stop" ADD COLUMN "appointmentWindowStartAt" TIMESTAMP(3);
ALTER TABLE "Stop" ADD COLUMN "appointmentWindowEndAt" TIMESTAMP(3);
