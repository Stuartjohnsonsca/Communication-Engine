-- Post-PRD hardening item 45: per-Membership email preferences for
-- opt-outable notification kinds.
--
-- One row per (membership, kind). Default behaviour (no row) = opted-in,
-- so this table is empty for users who have never touched the toggle.
-- The dispatcher (src/lib/notifications/dispatch.ts) consults this table
-- only when the kind is in `OPT_OUTABLE_KINDS`
-- (src/lib/notifications/preferences.ts); mandatory kinds always send
-- regardless. The `setEmailEnabled` helper refuses non-opt-outable kinds
-- with a ValidationError; this DB-level table doesn't enforce that — the
-- dispatcher's `isOptOutable` guard is the gate.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_PREFERENCE_CHANGED';

CREATE TABLE IF NOT EXISTS "MembershipNotificationPreference" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "membershipId"  TEXT NOT NULL,
  "kind"          TEXT NOT NULL,
  "emailEnabled"  BOOLEAN NOT NULL DEFAULT true,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MembershipNotificationPreference_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "MembershipNotificationPreference_membership_fk"
    FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MembershipNotificationPreference_member_kind_idx"
  ON "MembershipNotificationPreference" ("membershipId", "kind");
CREATE INDEX IF NOT EXISTS "MembershipNotificationPreference_tenant_member_idx"
  ON "MembershipNotificationPreference" ("tenantId", "membershipId");
