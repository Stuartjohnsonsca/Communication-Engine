-- Per-draft detail page: snapshot inbound + lineage so regenerate works
-- across both manual-paste and ingestion-driven flows.

ALTER TABLE "Draft"
  ADD COLUMN IF NOT EXISTS "inboundChannel" TEXT,
  ADD COLUMN IF NOT EXISTS "inboundSender"  TEXT,
  ADD COLUMN IF NOT EXISTS "inboundSubject" TEXT,
  ADD COLUMN IF NOT EXISTS "inboundBody"    TEXT,
  ADD COLUMN IF NOT EXISTS "parentId"       TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Draft_parentId_fkey'
  ) THEN
    ALTER TABLE "Draft"
      ADD CONSTRAINT "Draft_parentId_fkey"
      FOREIGN KEY ("parentId") REFERENCES "Draft"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'DRAFT_EDITED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'DRAFT_REGENERATED';
