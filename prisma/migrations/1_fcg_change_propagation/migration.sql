-- PRD §5.2.2 — FCG-amendment propagation to existing UCGs with grace-period auto-suspension.

-- Extend UCGStatus with CONFLICTED.
ALTER TYPE "UCGStatus" ADD VALUE IF NOT EXISTS 'CONFLICTED' BEFORE 'SUPERSEDED';

-- Audit event types for the propagation flow.
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'UCG_CONFLICT_FLAGGED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'UCG_RULE_AUTO_SUSPENDED';

-- Conflict-tracking columns on UserCultureGuide.
ALTER TABLE "UserCultureGuide"
  ADD COLUMN IF NOT EXISTS "conflictedSinceFcgId"    TEXT,
  ADD COLUMN IF NOT EXISTS "conflictFlaggedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "gracePeriodEndsAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "conflictAutoSuspendedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "UserCultureGuide_conflict_sweep_idx"
  ON "UserCultureGuide" ("tenantId", "status", "gracePeriodEndsAt");

-- Per-rule auto-suspension columns on UCGRule.
ALTER TABLE "UCGRule"
  ADD COLUMN IF NOT EXISTS "suspendedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "suspendReason" TEXT;
