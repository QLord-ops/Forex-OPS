CREATE TABLE "Dispatcher" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "login" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'dispatcher',
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "onboardingCompletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleNumber" TEXT NOT NULL,
    "licensePlate" TEXT,
    "currentTrailerPlate" TEXT,
    "manualPositionAddress" TEXT,
    "manualPositionLatitude" REAL,
    "manualPositionLongitude" REAL,
    "manualPositionAt" DATETIME,
    "maxSpeedKmh" INTEGER NOT NULL DEFAULT 85,
    "clockState" TEXT,
    "manualStoppedAt" DATETIME,
    "operationVersion" INTEGER NOT NULL DEFAULT 0,
    "truckProfile" TEXT,
    "assignedDispatcherId" TEXT,
    "assignedAt" DATETIME,
    "line" TEXT,
    "statusGroup" TEXT,
    "servicePhone" TEXT,
    "aSchild" BOOLEAN NOT NULL DEFAULT false,
    "appSped" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Vehicle_assignedDispatcherId_fkey" FOREIGN KEY ("assignedDispatcherId") REFERENCES "Dispatcher" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE TABLE "Tour" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "importAttemptId" TEXT,
    "importFingerprint" TEXT,
    "trailerPlate" TEXT,
    "tourRemarks" TEXT,
    "approachDurationSeconds" INTEGER,
    "approachDistanceMeters" INTEGER,
    "approachGeometry" TEXT,
    "planVersion" INTEGER NOT NULL DEFAULT 0,
    "queueIndex" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "previousTourId" TEXT,
    "plannedStartAt" DATETIME,
    "actualStartAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tour_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Tour_previousTourId_fkey" FOREIGN KEY ("previousTourId") REFERENCES "Tour" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE TABLE "Stop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tourId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "company" TEXT,
    "address" TEXT NOT NULL,
    "sourceAddress" TEXT,
    "resolvedAddress" TEXT,
    "geocodePrecision" TEXT,
    "geocodeProvider" TEXT,
    "city" TEXT,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "appointmentAt" DATETIME,
    "appointmentWindowStartAt" DATETIME,
    "appointmentWindowEndAt" DATETIME,
    "loadingMeters" REAL,
    "referenceNumbersJson" TEXT,
    "instructions" TEXT,
    "arrivedAt" DATETIME,
    "arrivalRadiusMeters" INTEGER,
    "plannedAt" DATETIME,
    "departureDeadlineAt" DATETIME,
    "terminRequired" BOOLEAN NOT NULL DEFAULT false,
    "serviceMinMinutes" INTEGER NOT NULL DEFAULT 60,
    "serviceMaxMinutes" INTEGER NOT NULL DEFAULT 120,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Stop_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Leg" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tourId" TEXT NOT NULL,
    "fromStopId" TEXT NOT NULL,
    "toStopId" TEXT NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "routeGeometry" TEXT NOT NULL,
    "routingDurationSeconds" INTEGER NOT NULL,
    "simulatedDurationSeconds" INTEGER NOT NULL,
    "drivePlan" TEXT,
    "routeDetails" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Leg_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Leg_fromStopId_fkey" FOREIGN KEY ("fromStopId") REFERENCES "Stop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Leg_toStopId_fkey" FOREIGN KEY ("toStopId") REFERENCES "Stop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "note" TEXT,
    CONSTRAINT "Event_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Event_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Event_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "Stop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "appointmentAt" DATETIME NOT NULL,
    "predictedEta" DATETIME NOT NULL,
    "predictedLateMinutes" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "Alert_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Alert_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Alert_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "Stop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "ApiQuota" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "used" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "OperationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "tourId" TEXT,
    "stopId" TEXT,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dedupKey" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "stopId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" DATETIME
);
CREATE TABLE "RouteRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tourId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "RoutePreview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tourId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "vehicleVersion" INTEGER NOT NULL,
    "inputJson" TEXT NOT NULL,
    "planJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "appliedAt" DATETIME
);
CREATE TABLE "VehicleIntegration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalNumber" TEXT,
    "externalPlate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VehicleIntegration_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "VehicleTelemetry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "speedKmh" REAL,
    "ignitionOn" BOOLEAN,
    "recordedAt" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawJson" TEXT,
    CONSTRAINT "VehicleTelemetry_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "IntegrationSyncState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "cursor" TEXT,
    "lockedUntil" DATETIME,
    "lastSnapshotAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "IntegrationReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "externalId" TEXT,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" DATETIME,
    "payloadJson" TEXT
);
CREATE UNIQUE INDEX "Vehicle_vehicleNumber_key" ON "Vehicle"("vehicleNumber");
CREATE UNIQUE INDEX "Tour_importAttemptId_key" ON "Tour"("importAttemptId");
CREATE UNIQUE INDEX "Tour_importFingerprint_key" ON "Tour"("importFingerprint");
CREATE INDEX "Tour_vehicleId_status_idx" ON "Tour"("vehicleId", "status");
CREATE INDEX "Tour_previousTourId_idx" ON "Tour"("previousTourId");
CREATE INDEX "Stop_tourId_sequence_idx" ON "Stop"("tourId", "sequence");
CREATE UNIQUE INDEX "Stop_tourId_sequence_key" ON "Stop"("tourId", "sequence");
CREATE INDEX "Leg_tourId_status_idx" ON "Leg"("tourId", "status");
CREATE INDEX "Event_vehicleId_timestamp_idx" ON "Event"("vehicleId", "timestamp");
CREATE INDEX "Event_tourId_timestamp_idx" ON "Event"("tourId", "timestamp");
CREATE INDEX "Alert_vehicleId_resolvedAt_idx" ON "Alert"("vehicleId", "resolvedAt");
CREATE UNIQUE INDEX "Alert_stopId_type_key" ON "Alert"("stopId", "type");
CREATE INDEX "OperationEvent_vehicleId_createdAt_idx" ON "OperationEvent"("vehicleId", "createdAt");
CREATE UNIQUE INDEX "Notification_dedupKey_key" ON "Notification"("dedupKey");
CREATE INDEX "Notification_acknowledgedAt_createdAt_idx" ON "Notification"("acknowledgedAt", "createdAt");
CREATE INDEX "RouteRevision_tourId_version_idx" ON "RouteRevision"("tourId", "version");
CREATE INDEX "RoutePreview_tourId_createdAt_idx" ON "RoutePreview"("tourId", "createdAt");
CREATE UNIQUE INDEX "VehicleIntegration_provider_externalId_key" ON "VehicleIntegration"("provider", "externalId");
CREATE UNIQUE INDEX "VehicleIntegration_provider_vehicleId_key" ON "VehicleIntegration"("provider", "vehicleId");
CREATE INDEX "VehicleIntegration_provider_externalNumber_idx" ON "VehicleIntegration"("provider", "externalNumber");
CREATE INDEX "VehicleIntegration_provider_externalPlate_idx" ON "VehicleIntegration"("provider", "externalPlate");
CREATE UNIQUE INDEX "VehicleTelemetry_provider_externalId_recordedAt_key" ON "VehicleTelemetry"("provider", "externalId", "recordedAt");
CREATE INDEX "VehicleTelemetry_vehicleId_recordedAt_idx" ON "VehicleTelemetry"("vehicleId", "recordedAt");
CREATE INDEX "IntegrationSyncState_provider_lockedUntil_idx" ON "IntegrationSyncState"("provider", "lockedUntil");
CREATE UNIQUE INDEX "IntegrationReceipt_provider_messageId_key" ON "IntegrationReceipt"("provider", "messageId");
CREATE INDEX "IntegrationReceipt_provider_acknowledgedAt_idx" ON "IntegrationReceipt"("provider", "acknowledgedAt");
CREATE TABLE "AssistantConversation" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_DATETIME, "updatedAt" DATETIME NOT NULL);
CREATE TABLE "AssistantMessage" ("id" TEXT NOT NULL PRIMARY KEY, "conversationId" TEXT NOT NULL REFERENCES "AssistantConversation"("id") ON DELETE CASCADE, "role" TEXT NOT NULL, "content" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_DATETIME);
CREATE INDEX "AssistantMessage_conversationId_createdAt_idx" ON "AssistantMessage"("conversationId", "createdAt");
CREATE TABLE "AssistantProposal" ("id" TEXT NOT NULL PRIMARY KEY, "conversationId" TEXT NOT NULL REFERENCES "AssistantConversation"("id") ON DELETE CASCADE, "vehicleId" TEXT, "vehicleVersion" INTEGER, "contextJson" TEXT NOT NULL, "action" TEXT NOT NULL, "summary" TEXT NOT NULL, "inputJson" TEXT NOT NULL, "previewJson" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "resultJson" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_DATETIME, "expiresAt" DATETIME NOT NULL, "appliedAt" DATETIME);
CREATE INDEX "AssistantProposal_conversationId_createdAt_idx" ON "AssistantProposal"("conversationId", "createdAt");
CREATE TABLE "AssistantUsage" ("id" TEXT NOT NULL PRIMARY KEY, "count" INTEGER NOT NULL DEFAULT 0, "expiresAt" DATETIME NOT NULL);
CREATE TABLE "VehicleIssue" ("id" TEXT NOT NULL PRIMARY KEY, "vehicleId" TEXT NOT NULL REFERENCES "Vehicle"("id") ON DELETE CASCADE, "kind" TEXT NOT NULL, "description" TEXT NOT NULL, "expectedResolvedAt" DATETIME, "resolvedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_DATETIME);
CREATE INDEX "VehicleIssue_vehicleId_resolvedAt_idx" ON "VehicleIssue"("vehicleId", "resolvedAt");
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorRole" TEXT NOT NULL,
    "actorSessionId" TEXT NOT NULL,
    "actorDispatcherId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "tourId" TEXT,
    "stopId" TEXT,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");
CREATE INDEX "AuditLog_actorSessionId_createdAt_idx" ON "AuditLog"("actorSessionId", "createdAt");
CREATE TABLE "PendingAppointment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentKind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "vehiclePlate" TEXT,
    "vehicleId" TEXT,
    "company" TEXT,
    "site" TEXT,
    "city" TEXT,
    "stopType" TEXT,
    "appointmentAt" DATETIME,
    "windowStartAt" DATETIME,
    "windowEndAt" DATETIME,
    "referencesJson" TEXT,
    "sourceExcerpt" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attachedStopId" TEXT,
    "createdByDispatcherId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PendingAppointment_fingerprint_key" ON "PendingAppointment"("fingerprint");
CREATE INDEX "PendingAppointment_status_createdAt_idx" ON "PendingAppointment"("status", "createdAt");
CREATE INDEX "PendingAppointment_vehicleId_status_idx" ON "PendingAppointment"("vehicleId", "status");
CREATE INDEX "AuditLog_actorDispatcherId_createdAt_idx" ON "AuditLog"("actorDispatcherId", "createdAt");
CREATE UNIQUE INDEX "Dispatcher_login_key" ON "Dispatcher"("login");
CREATE INDEX "Vehicle_assignedDispatcherId_idx" ON "Vehicle"("assignedDispatcherId");
CREATE TABLE "AddressRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pattern" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "company" TEXT,
    "street" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "latitude" REAL,
    "longitude" REAL,
    "requiresTermin" BOOLEAN NOT NULL DEFAULT false,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdByDispatcherId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AddressRule_pattern_key" ON "AddressRule"("pattern");
CREATE INDEX "Vehicle_line_statusGroup_idx" ON "Vehicle"("line", "statusGroup");
-- 07:00 status list per customer line and Berlin day.
CREATE TABLE "DailyStatusReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "line" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GENERATING',
    "preliminary" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" DATETIME,
    "generatedByRole" TEXT NOT NULL,
    "generatedByDispatcherId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "DailyStatusReport_line_date_key" ON "DailyStatusReport"("line", "date");
CREATE TABLE "DailyStatusRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "vehicleNumber" TEXT NOT NULL,
    "statusGroup" TEXT,
    "sortIndex" INTEGER NOT NULL,
    "rule" TEXT NOT NULL,
    "ort" TEXT,
    "ortSource" TEXT,
    "startAt" DATETIME,
    "startKind" TEXT NOT NULL,
    "ziel" TEXT,
    "ankunftAt" DATETIME,
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
    "editedAt" DATETIME,
    "editedByDispatcherId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DailyStatusRow_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "DailyStatusReport" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DailyStatusRow_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DailyStatusRow_reportId_vehicleId_key" ON "DailyStatusRow"("reportId", "vehicleId");
CREATE INDEX "DailyStatusRow_reportId_sortIndex_idx" ON "DailyStatusRow"("reportId", "sortIndex");
-- Saved addresses for suggestions (Webfleet address book).
CREATE TABLE "KnownAddress" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "radiusMeters" INTEGER,
    "groups" TEXT,
    "searchText" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "KnownAddress_source_externalId_key" ON "KnownAddress"("source", "externalId");
CREATE INDEX "KnownAddress_active_idx" ON "KnownAddress"("active");
CREATE TABLE "OrderDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sha256" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content" BLOB NOT NULL,
    "previewJson" TEXT NOT NULL,
    "confirmedJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "uploadedByDispatcherId" TEXT,
    "vehicleId" TEXT,
    "tourId" TEXT,
    "attachedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderDocument_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrderDocument_sha256_key" ON "OrderDocument"("sha256");
CREATE UNIQUE INDEX "OrderDocument_tourId_key" ON "OrderDocument"("tourId");
CREATE INDEX "OrderDocument_status_createdAt_idx" ON "OrderDocument"("status", "createdAt");
CREATE INDEX "OrderDocument_vehicleId_createdAt_idx" ON "OrderDocument"("vehicleId", "createdAt");
CREATE TABLE "ImportCorrection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "tourId" TEXT,
    "dispatcherId" TEXT,
    "kind" TEXT NOT NULL,
    "field" TEXT,
    "aiValue" TEXT,
    "finalValue" TEXT,
    "contextJson" TEXT,
    "signature" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportCorrection_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "OrderDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ImportCorrection_signature_createdAt_idx" ON "ImportCorrection"("signature", "createdAt");
CREATE INDEX "ImportCorrection_documentId_idx" ON "ImportCorrection"("documentId");
CREATE INDEX "ImportCorrection_tourId_idx" ON "ImportCorrection"("tourId");
CREATE TABLE "ImportRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "value" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ImportRule_kind_pattern_key" ON "ImportRule"("kind", "pattern");
