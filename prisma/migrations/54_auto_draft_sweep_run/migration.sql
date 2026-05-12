-- Post-PRD hardening item 52: persist one row per auto-draft sweep pass
-- per tenant so operators can see what the engine is doing (candidates,
-- produced, skipped, errored, and a skip-reason histogram). Renders on
-- /admin/channels as "Recent auto-draft activity".

CREATE TYPE "AutoDraftSweepSource" AS ENUM ('CRON', 'BACKFILL');

CREATE TABLE "AutoDraftSweepRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" "AutoDraftSweepSource" NOT NULL,
    "triggeredByMembershipId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowHours" INTEGER NOT NULL,
    "maxPerTenant" INTEGER NOT NULL,
    "candidates" INTEGER NOT NULL DEFAULT 0,
    "produced" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "errored" INTEGER NOT NULL DEFAULT 0,
    "skipReasons" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AutoDraftSweepRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutoDraftSweepRun_tenantId_startedAt_idx"
    ON "AutoDraftSweepRun"("tenantId", "startedAt" DESC);

CREATE INDEX "AutoDraftSweepRun_source_idx"
    ON "AutoDraftSweepRun"("source");

ALTER TABLE "AutoDraftSweepRun"
    ADD CONSTRAINT "AutoDraftSweepRun_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AutoDraftSweepRun"
    ADD CONSTRAINT "AutoDraftSweepRun_triggeredByMembershipId_fkey"
    FOREIGN KEY ("triggeredByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
