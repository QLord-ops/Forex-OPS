-- Optional per-stop geofence radius for automatic GPS arrival (NULL = default 500 m).
ALTER TABLE "Stop" ADD COLUMN "arrivalRadiusMeters" INTEGER;
