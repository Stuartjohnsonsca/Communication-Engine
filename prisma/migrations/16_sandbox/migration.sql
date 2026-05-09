-- PRD §14.2 Sandbox / Dry-Run lifecycle. The Tenant table already had
-- `isSandbox` + `parentTenantId` self-relation from the Phase 1 schema;
-- this migration adds the lifecycle columns:
--   * sandboxOpenedAt / sandboxClosesAt — the dry-run window (default 30d).
--   * sandboxCohortLimit — max users in the sandbox cohort (default 10).
--   * sandboxOutcome / At / ByName / Notes — terminal outcome captured on
--     conclusion (PENDING → PROMOTED / ITERATING / DECLINED).
--   * sandboxPromotedFcgId / sandboxPromotedProposalId — when promoted, the
--     FCG chosen and the proposal staged on the parent tenant.
--
-- The new `SandboxOutcome` enum and four `SANDBOX_*` audit event types are
-- added too.

-- ─── Enums ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SandboxOutcome') THEN
    CREATE TYPE "SandboxOutcome" AS ENUM ('PENDING', 'PROMOTED', 'ITERATING', 'DECLINED');
  END IF;
END $$;

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SANDBOX_PROVISIONED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SANDBOX_MEMBER_ADDED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SANDBOX_FCG_PROMOTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SANDBOX_OUTCOME_RECORDED';

-- ─── Tenant columns ────────────────────────────────────────────────────────

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "sandboxOpenedAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sandboxClosesAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sandboxCohortLimit"        INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "sandboxOutcome"            "SandboxOutcome" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "sandboxOutcomeAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sandboxOutcomeByName"      TEXT,
  ADD COLUMN IF NOT EXISTS "sandboxOutcomeNotes"       TEXT,
  ADD COLUMN IF NOT EXISTS "sandboxPromotedFcgId"      TEXT,
  ADD COLUMN IF NOT EXISTS "sandboxPromotedProposalId" TEXT;

CREATE INDEX IF NOT EXISTS "Tenant_parentTenantId_isSandbox_idx"
  ON "Tenant"("parentTenantId", "isSandbox");
