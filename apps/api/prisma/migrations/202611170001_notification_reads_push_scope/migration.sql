-- Own trucks only (owner, 17.11). Additive only: one new column with a default and one new table; no row is changed.

-- An admin's «Мои линии» on a phone: only their own trucks ring it.
ALTER TABLE "PushSubscription" ADD COLUMN "ownOnly" BOOLEAN NOT NULL DEFAULT false;

-- An admin set a colleague's notification aside for themselves: it stays open for the dispatcher who runs the truck.
CREATE TABLE "NotificationRead" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "dispatcherId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationRead_notificationId_dispatcherId_key" ON "NotificationRead"("notificationId", "dispatcherId");
CREATE INDEX "NotificationRead_dispatcherId_idx" ON "NotificationRead"("dispatcherId");
ALTER TABLE "NotificationRead" ADD CONSTRAINT "NotificationRead_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationRead" ADD CONSTRAINT "NotificationRead_dispatcherId_fkey" FOREIGN KEY ("dispatcherId") REFERENCES "Dispatcher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
