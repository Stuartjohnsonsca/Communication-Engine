-- Post-PRD hardening item 22: cron heartbeat monitoring + stall alerting.
--
-- The platform now runs five load-bearing cron endpoints:
--   /api/cron/lifecycle-sweep   (daily)
--   /api/cron/billing-close     (daily)
--   /api/cron/termination       (daily)
--   /api/cron/digest            (weekly)
--   /api/cron/webhooks-deliver  (every minute)
--
-- If any of these stop firing — Railway cron misconfigured, CRON_SECRET
-- rotated and not redeployed, the auth route returning 401, the worker
-- silently throwing — there is no signal until a Client notices something
-- downstream is broken (webhook receivers miss events, sessions never time
-- out, billing periods don't close). This item closes that detection gap.
--
-- `CronHeartbeat` is one row per registered cron name, upserted on every
-- run by the `withCronHeartbeat(name, fn)` wrapper in
-- `src/lib/cron-health/`. The wrapper sets `lastRunAt` unconditionally;
-- on success it bumps `lastSuccessAt` + `lastDurationMs` and resets
-- `consecutiveFailures` to 0; on throw it bumps `lastFailureAt` +
-- `lastErrorMessage` and increments `consecutiveFailures`.
--
-- A separate periodic worker (`/api/cron/health-check`, every 15 min)
-- runs `evaluateCronHealth()` and writes one `CRON_STALLED` audit event
-- + immediate notification per stalled cron, deduped via
-- `stalledNotifiedAt`. Re-alert only fires after the next expected
-- interval has passed so an operator sees one alert per genuine stall
-- window, not one every 15 minutes.
--
-- Global model (no tenantId) — cron schedules are platform-wide, not
-- per-tenant. Audit events for stalls write on the Acumon operator
-- tenant chain (the chain is per-tenant by design; "platform-wide
-- operator events live on the operator chain" is the established
-- pattern, same as Roadmap §16 / Risks §17).
--
-- We deliberately do NOT write a CRON_RUN_SUCCEEDED audit event on every
-- successful run — webhooks-deliver fires every minute, that's 1440
-- audit rows/day per cron, and the row update on CronHeartbeat is the
-- forensic record we actually need.

CREATE TABLE "CronHeartbeat" (
  "cronName"                TEXT PRIMARY KEY,
  "expectedIntervalMinutes" INTEGER NOT NULL,
  "lastRunAt"               TIMESTAMP(3),
  "lastSuccessAt"           TIMESTAMP(3),
  "lastFailureAt"           TIMESTAMP(3),
  "lastErrorMessage"        TEXT,
  "lastDurationMs"          INTEGER,
  "consecutiveFailures"     INTEGER NOT NULL DEFAULT 0,
  "stalledNotifiedAt"       TIMESTAMP(3),
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX "CronHeartbeat_lastSuccessAt_idx" ON "CronHeartbeat"("lastSuccessAt");

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CRON_RUN_FAILED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CRON_STALLED';
