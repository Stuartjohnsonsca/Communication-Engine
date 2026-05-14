-- Post-PRD hardening item 104 — per-staff-member self-service OAuth.
-- New audit type so chain readers can distinguish "User revoked their
-- own auth" from "FIRM_ADMIN force-revoked another User's auth"
-- (payload.byActor = "self" | "admin"). Distinct from the existing
-- CHANNEL_AUTHORISED which records the connect side.
--
-- ALTER TYPE IF NOT EXISTS for fresh-deploy safety.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CHANNEL_DEAUTHORISED';
