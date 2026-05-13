-- Post-PRD hardening item 77 — hourly cron warns when a sentiment
-- escalation has been left unacknowledged for STALE_THRESHOLD_HOURS.
-- Mirrors item 54's draft-stale pattern but for the PRD §9.3 sentiment
-- path. New audit event so the chain records the second-chance nudge
-- alongside the original SENTIMENT_ESCALATED row.
--
-- `IF NOT EXISTS` for fresh-deploy safety: a clean deploy picks the
-- value up from the Prisma schema, an existing deploy needs the ALTER.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SENTIMENT_ESCALATION_STALE_WARNED';
