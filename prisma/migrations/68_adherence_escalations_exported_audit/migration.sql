-- Post-PRD hardening item 89 — uncapped per-escalation CSV export of
-- adherence escalations (acknowledged + open-overdue) in a window.
-- Sister audit type to `SENTIMENT_RESPONSES_EXPORTED` (item 83) on the
-- adherence pillar: distinct from any future aggregate-rollup audit
-- type because this carries every per-escalation row in the window,
-- uncapped by the /adherence/escalations page's display limit.
--
-- `IF NOT EXISTS` for fresh-deploy safety: a clean deploy picks the
-- value up from the Prisma schema, an existing deploy needs the ALTER.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ADHERENCE_ESCALATIONS_EXPORTED';
