-- Personal dispatcher accounts. Additive only: existing tables keep all data, new columns are nullable.
CREATE TABLE "Dispatcher" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'dispatcher',
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Dispatcher_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Dispatcher_login_key" ON "Dispatcher"("login");

-- Which dispatcher looks after a truck. NULL = free truck.
ALTER TABLE "Vehicle" ADD COLUMN "assignedDispatcherId" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "assignedAt" TIMESTAMP(3);
CREATE INDEX "Vehicle_assignedDispatcherId_idx" ON "Vehicle"("assignedDispatcherId");
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_assignedDispatcherId_fkey" FOREIGN KEY ("assignedDispatcherId") REFERENCES "Dispatcher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The person behind an audited action; NULL for system actions and shared-password sessions.
ALTER TABLE "AuditLog" ADD COLUMN "actorDispatcherId" TEXT;
CREATE INDEX "AuditLog_actorDispatcherId_createdAt_idx" ON "AuditLog"("actorDispatcherId", "createdAt");
