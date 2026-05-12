-- Post-PRD hardening item 62 — per-inbound draft-attempt quarantine.
--
-- Item 61 introduced auto-resume + anti-thrash; a side-effect is that
-- a single broken inbound (malformed encoding, oversized attachment,
-- prompt-jailbreak input) would now keep failing every cron tick.
-- Three failures would trip the breaker, auto-resume waits 30 min,
-- another three failures would lock the tenant on ONE bad message.
-- The fix is per-message quarantine: after N consecutive failed
-- draft attempts for the same IngestedMessage, mark it quarantined
-- and skip it on subsequent sweeps. The tenant-wide circuit breaker
-- threshold (5 in 30 min) is now higher than the quarantine
-- threshold (3 attempts), so a single broken inbound is contained
-- before it can trip the breaker.
--
-- The four columns are nullable / default-0 so existing rows
-- automatically read as "0 attempts, not quarantined" — no backfill
-- needed. The two new AuditEventType values are appended with
-- IF NOT EXISTS for fresh-deploy safety.

ALTER TABLE "IngestedMessage"
    ADD COLUMN "draftAttemptCount"      INTEGER       NOT NULL DEFAULT 0,
    ADD COLUMN "lastDraftAttemptAt"     TIMESTAMP(3),
    ADD COLUMN "quarantinedFromDraftAt" TIMESTAMP(3),
    ADD COLUMN "quarantineReason"       TEXT;

-- Partial index so the sweep's `quarantinedFromDraftAt IS NULL` filter
-- plus the existing `direction = 'IN'` and `drafts: { none: {} }`
-- predicates stay cheap as inbound volume grows. Quarantined rows are
-- the minority — keep the index lean by excluding them at the index
-- level.
CREATE INDEX "IngestedMessage_tenantId_direction_quarantine_idx"
    ON "IngestedMessage" ("tenantId", "direction")
    WHERE "quarantinedFromDraftAt" IS NULL;

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'INBOUND_DRAFT_QUARANTINED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'INBOUND_DRAFT_UNQUARANTINED';
