-- Push notifications to the dispatchers' phones (PWA). Additive only: a new table, nothing else changes.
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "dispatcherId" TEXT,
    "workHoursJson" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_dispatcherId_idx" ON "PushSubscription"("dispatcherId");
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_dispatcherId_fkey" FOREIGN KEY ("dispatcherId") REFERENCES "Dispatcher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
