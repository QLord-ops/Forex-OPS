-- One dispatcher works for another for a while. Additive only: a new table, nothing else changes.
CREATE TABLE "DispatcherCover" (
    "id" TEXT NOT NULL,
    "absentDispatcherId" TEXT NOT NULL,
    "coverDispatcherId" TEXT NOT NULL,
    "lineIdsJson" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedByDispatcherId" TEXT,
    "createdByDispatcherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatcherCover_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DispatcherCover_absentDispatcherId_endsAt_idx" ON "DispatcherCover"("absentDispatcherId", "endsAt");
CREATE INDEX "DispatcherCover_coverDispatcherId_endsAt_idx" ON "DispatcherCover"("coverDispatcherId", "endsAt");
ALTER TABLE "DispatcherCover" ADD CONSTRAINT "DispatcherCover_absentDispatcherId_fkey" FOREIGN KEY ("absentDispatcherId") REFERENCES "Dispatcher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DispatcherCover" ADD CONSTRAINT "DispatcherCover_coverDispatcherId_fkey" FOREIGN KEY ("coverDispatcherId") REFERENCES "Dispatcher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
