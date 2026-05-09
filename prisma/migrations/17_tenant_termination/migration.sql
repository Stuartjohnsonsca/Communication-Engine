-- PRD §14.4 Tenant Termination. Adds:
--   * `TERMINATING` state to TenantStatus — the wind-down window between
--     notice and the 90-day hard-delete cut-off.
--   * Termination lifecycle columns on Tenant: noticeAt, byName, reason,
--     effectiveAt (default = noticeAt + 90 days), completedAt, the most
--     recent export package id, and a per-tenant statutory retention
--     floor for the data §12.5 keeps after deletion (audit + DPIA).
--   * `TenantTerminationExport` table holding the JSON snapshot bundle —
--     FCGs, UCGs, drafts, meeting records, audit chain, DPIA, DSARs,
--     billing periods, sign-off questions. Tenant-scoped + indexed for the
--     wind-down UI to list "previous packages".
--   * Audit event types for the lifecycle.
--
-- TenantTerminationExport is added to the RLS array via prisma/rls.sql so
-- packages stay tenant-isolated even though the row physically lives on
-- the same DB as every other tenant's export.

-- ─── Enum extensions ───────────────────────────────────────────────────────

ALTER TYPE "TenantStatus" ADD VALUE IF NOT EXISTS 'TERMINATING';

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TENANT_TERMINATION_NOTICED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TENANT_TERMINATION_REVERSED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TENANT_TERMINATION_EXPORT_GENERATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TENANT_HARD_DELETED';

-- ─── Tenant columns ────────────────────────────────────────────────────────

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "terminationNoticeAt"                TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "terminationByName"                  TEXT,
  ADD COLUMN IF NOT EXISTS "terminationReason"                  TEXT,
  ADD COLUMN IF NOT EXISTS "terminationEffectiveAt"             TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "terminationCompletedAt"             TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "terminationExportPackageId"         TEXT,
  ADD COLUMN IF NOT EXISTS "terminationStatutoryRetentionUntil" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Tenant_terminationEffectiveAt_idx"
  ON "Tenant"("terminationEffectiveAt")
  WHERE "terminationEffectiveAt" IS NOT NULL;

-- ─── TenantTerminationExport ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "TenantTerminationExport" (
  "id"                      TEXT PRIMARY KEY,
  "tenantId"                TEXT NOT NULL,
  "generatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "generatedByMembershipId" TEXT,
  "generatedByName"         TEXT,
  "payload"                 JSONB NOT NULL,
  "bytes"                   INTEGER NOT NULL,
  "counts"                  JSONB NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TenantTerminationExport_tenantId_fkey'
  ) THEN
    ALTER TABLE "TenantTerminationExport"
      ADD CONSTRAINT "TenantTerminationExport_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "TenantTerminationExport_tenantId_generatedAt_idx"
  ON "TenantTerminationExport"("tenantId", "generatedAt");
