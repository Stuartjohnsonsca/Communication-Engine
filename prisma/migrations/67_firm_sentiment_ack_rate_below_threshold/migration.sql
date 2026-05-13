-- Post-PRD hardening item 84 — firm-wide sentiment ack-rate escalation.
-- Sister to `FIRM_ADHERENCE_BELOW_THRESHOLD` (item 71) on the sentiment
-- side: a daily cron flags tenants whose 7d ack rate is below
-- `ACK_RATE_THRESHOLD` with a meaningful volume floor.
--
-- `IF NOT EXISTS` for fresh-deploy safety: a clean deploy picks the
-- value up from the Prisma schema, an existing deploy needs the ALTER.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'FIRM_SENTIMENT_ACK_RATE_BELOW_THRESHOLD';
