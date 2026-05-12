-- Post-PRD hardening item 68 — CSV export of the /admin/drafts rollup
-- for compliance reporting / partner reviews. Each export writes a
-- DRAFTS_ROLLUP_EXPORTED audit event so the chain records who pulled
-- the report, when, and over what window.
--
-- `IF NOT EXISTS` for fresh-deploy safety: an empty deploy will pick
-- up this value from the schema, an existing deploy needs the ALTER.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'DRAFTS_ROLLUP_EXPORTED';
