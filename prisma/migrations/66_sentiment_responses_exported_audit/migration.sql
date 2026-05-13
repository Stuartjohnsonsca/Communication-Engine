-- Post-PRD hardening item 83 — uncapped per-signal CSV export of
-- sentiment responses (acknowledged + open-overdue escalations).
-- Sister audit type to `FCG_MISSES_EXPORTED` (item 76) on the
-- sentiment side: distinct from any future aggregate-rollup audit
-- type because this carries every per-signal row in the window,
-- uncapped by the /sentiment page's display limit.
--
-- `IF NOT EXISTS` for fresh-deploy safety: a clean deploy picks the
-- value up from the Prisma schema, an existing deploy needs the ALTER.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SENTIMENT_RESPONSES_EXPORTED';
