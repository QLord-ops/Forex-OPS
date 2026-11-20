-- Driver app (owner, 19.11): «Диспетчер» tab calls the dispatcher who runs the truck.
-- Additive only: one nullable column, no row is changed. A work number of the dispatch desk, never a private one (DSGVO).
ALTER TABLE "Dispatcher" ADD COLUMN "workPhone" TEXT;
