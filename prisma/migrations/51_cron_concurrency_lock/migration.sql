-- Post-PRD hardening item 47: cron concurrency lock via pg_try_advisory_lock.
-- A second invocation of an in-flight cron exits with no-op rather than
-- running the workload twice. The advisory lock itself is a Postgres
-- primitive — nothing to migrate other than the audit event signalling
-- the skip.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CRON_RUN_SKIPPED_CONCURRENT';
