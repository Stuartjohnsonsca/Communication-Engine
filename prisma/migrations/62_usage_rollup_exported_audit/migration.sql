-- Post-PRD hardening item 70 — CSV export of /admin/usage for
-- finance / procurement reporting. Each export writes a
-- USAGE_ROLLUP_EXPORTED audit event so the chain records who pulled
-- the cost rollup, when, and over what window.
--
-- `IF NOT EXISTS` so a fresh deploy that already has this value
-- from the schema doesn't fail; an existing deploy needs the ALTER.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'USAGE_ROLLUP_EXPORTED';
