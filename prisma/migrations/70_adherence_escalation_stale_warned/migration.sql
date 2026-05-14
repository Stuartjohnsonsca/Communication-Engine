-- Post-PRD hardening item 99 — hourly cron warns when an adherence
-- escalation has been left unacknowledged for STALE_THRESHOLD_HOURS.
-- Adherence-pillar analog of item 77's SENTIMENT_ESCALATION_STALE_WARNED.
-- New audit event so the chain records the second-chance nudge alongside
-- the original ADHERENCE_ESCALATED row.
--
-- `IF NOT EXISTS` for fresh-deploy safety: a clean deploy picks the
-- value up from the Prisma schema, an existing deploy needs the ALTER.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ADHERENCE_ESCALATION_STALE_WARNED';
