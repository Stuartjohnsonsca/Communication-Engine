-- Post-PRD hardening item 54: stale-draft sweeper. A daily cron warns
-- the owning Membership when a Draft's fcgWindowDeadline has passed
-- without send/discard, so the FCG's "respond within N hours" promise
-- doesn't silently break. Dedupes via the NotificationDispatch table;
-- one DRAFT_STALE_WARNED audit row per draft.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'DRAFT_STALE_WARNED';
