-- User Lifecycle (PRD §14.3). Joiner/mover are already covered by the
-- existing FCG/UCG flows; this migration adds the storage needed for the
-- two state transitions that have material processing consequences:
--
--   * User-initiated revocation: the User pulls source-system access. A
--     30-day grace window is granted before the UCG is anonymised and the
--     membership suspended. During the grace window, drafting halts but
--     the User can still re-authorise from /account.
--
--   * Firm-Admin-initiated leaver: a member is leaving the firm. Membership
--     transitions to LEAVER_FROZEN immediately; after 30 calendar days the
--     sweep anonymises the UCG and moves the membership to ANONYMISED.
--
-- The existing `MembershipStatus` enum already has the LEAVER_FROZEN /
-- ANONYMISED / SUSPENDED values needed; we only add new lifecycle
-- timestamps to Membership and UserCultureGuide, plus the audit event
-- types.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'USER_ACCESS_REVOKED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'USER_REAUTHORISED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'USER_MARKED_LEAVER';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'USER_LEAVER_REVERSED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEMBERSHIP_SUSPENDED_AFTER_GRACE';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'MEMBERSHIP_ANONYMISED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'UCG_FROZEN';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'UCG_ANONYMISED';

ALTER TYPE "UCGStatus" ADD VALUE IF NOT EXISTS 'ANONYMISED';

ALTER TABLE "Membership"
  ADD COLUMN IF NOT EXISTS "accessRevokedAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reauthDeadlineAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "leaverMarkedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "anonymiseDueAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "anonymisedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lifecycleNotes"   TEXT;

ALTER TABLE "UserCultureGuide"
  ADD COLUMN IF NOT EXISTS "frozenAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "anonymisedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Membership_tenantId_anonymiseDueAt_idx"
  ON "Membership"("tenantId", "anonymiseDueAt");
CREATE INDEX IF NOT EXISTS "Membership_tenantId_reauthDeadlineAt_idx"
  ON "Membership"("tenantId", "reauthDeadlineAt");
