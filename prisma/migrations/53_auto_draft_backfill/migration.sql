-- Post-PRD hardening item 51: operator-triggered backfill of
-- auto-drafting on historic ingested inbound. Adds the audit event
-- so a reviewer can answer "who pressed the button, when, and what
-- window did they choose" — distinct from per-draft DRAFT_PRODUCED
-- entries which the auto-draft cron emits one-per-draft.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'AUTO_DRAFT_BACKFILL_TRIGGERED';
