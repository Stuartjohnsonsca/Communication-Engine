-- Post-PRD hardening item 76 — full-list CSV export of FCG-window
-- misses (sent-after + open-overdue, uncapped). Distinct from the
-- aggregate `DRAFTS_ROLLUP_EXPORTED` (item 68): that's the rollup
-- numbers; this is the per-row breach list.
--
-- `IF NOT EXISTS` for fresh-deploy safety: a clean deploy picks the
-- value up from the Prisma schema, an existing deploy needs the ALTER.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'FCG_MISSES_EXPORTED';
