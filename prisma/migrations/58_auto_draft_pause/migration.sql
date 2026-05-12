-- Post-PRD hardening item 58 — tenant-level auto-draft pause. Adds an
-- operator-controlled circuit breaker on the Tenant row, plus two new
-- AuditEventType values that record pause + resume actions.
--
-- Null pause timestamp = enabled (current behaviour preserved). Non-null
-- = paused at that moment; produceDraftFromInbound short-circuits with
-- skip code `auto_draft_paused`. The 5-minute auto-draft cron still
-- runs (the sweep-run row records the skip), and User-pasted drafting
-- via /drafts/new continues to work. Per-Member lifecycle halt
-- (`drafting_halted`) is a distinct gate that still applies on top.

ALTER TABLE "Tenant"
    ADD COLUMN "autoDraftPausedAt" TIMESTAMP(3),
    ADD COLUMN "autoDraftPausedByName" TEXT,
    ADD COLUMN "autoDraftPauseReason" TEXT;

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'AUTO_DRAFT_PAUSED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'AUTO_DRAFT_RESUMED';
