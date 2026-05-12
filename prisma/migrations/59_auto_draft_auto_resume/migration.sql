-- Post-PRD hardening item 61 — auto-draft circuit-breaker auto-resume.
--
-- Item 59 trips the breaker on repeated LLM failures and pauses the
-- tenant; today the only way back out is a human clicking Resume on
-- /admin/channels. For a transient provider outage (5xx storm,
-- rate-limit window) that clears in minutes, this leaves the engine
-- off for hours until somebody notices — the opposite of the "no
-- missed comms" promise. This migration adds one column so the
-- breaker can recognise it has previously auto-resumed within an
-- anti-thrash window and refuse to auto-resume a second time
-- (escalating to the new "(circuit-breaker-locked)" sentinel,
-- handled in application code).
--
-- Reuses the existing `AUTO_DRAFT_RESUMED` audit enum value with an
-- `autoResumed: true` payload discriminator, mirroring item 59's
-- `AUTO_DRAFT_PAUSED { autoPaused: true }` pattern. No new enum.

ALTER TABLE "Tenant"
    ADD COLUMN "autoDraftAutoResumeAt" TIMESTAMP(3);
