-- Post-PRD hardening item 15: idle + absolute session timeout.
--
-- Item 13 added explicit revocation; item 12 added a second factor. The
-- remaining gap a procurement reviewer asks for is automatic invalidation
-- of a session that has been idle too long or that has been open for more
-- than the tenant's absolute ceiling regardless of activity. Closing a
-- laptop lid does NOT silently keep a cookie valid for weeks: idle timeout
-- catches that; absolute timeout caps the longest possible session age so
-- a forgotten signed-in browser eventually expires without explicit
-- revocation.
--
-- Configuration is per-tenant (not global) because firm risk appetite
-- varies — a small firm may be comfortable with 8h idle, a larger one may
-- want 30m. When a User has memberships in multiple tenants we apply the
-- STRICTEST of their tenants' policies; sessions are per-User-global, so
-- the conservative choice is to take the smallest threshold.
--
-- Two new tenant columns:
--   sessionIdleTimeoutMinutes     — null = inherit default (60 minutes).
--                                   When non-null and the gap between now
--                                   and Session.lastSeenAt exceeds this
--                                   value, the session is auto-revoked
--                                   with reason="idle-timeout".
--   sessionAbsoluteTimeoutMinutes — null = inherit default (1440 = 24h).
--                                   When non-null and the gap between now
--                                   and Session.createdAt exceeds this
--                                   value, the session is auto-revoked
--                                   with reason="absolute-timeout".
--
-- Implementation reuses existing revoke audit events
-- (SESSION_REVOKED with `reason` payload) rather than adding new event
-- types — the audit shape is the same; only the cause differs. The actor
-- is recorded as null (system, not a User) and Session.revokedById is
-- left null for system-driven revocations.

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "sessionIdleTimeoutMinutes"     INTEGER,
  ADD COLUMN IF NOT EXISTS "sessionAbsoluteTimeoutMinutes" INTEGER;

-- One new audit-event type: the Firm Administrator changing the per-tenant
-- thresholds is a meaningful security policy change. The auto-revocations
-- themselves reuse SESSION_REVOKED (with reason="idle-timeout" /
-- "absolute-timeout" in the payload) so we don't churn the event-type set
-- for what is essentially the same kind of state transition.
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TENANT_SESSION_TIMEOUT_CHANGED';
