-- Post-PRD hardening item 100 — per-tenant cron threshold overrides.
-- One row per tenant, all knobs nullable (NULL = use platform default).
-- The resolver in src/lib/cron-thresholds/resolve.ts merges row-or-default.
--
-- Mirrors the established post-PRD pattern: enum value goes via ALTER TYPE
-- IF NOT EXISTS for fresh-deploy safety; the new model + back-relation are
-- standard Prisma DDL.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TENANT_CRON_THRESHOLDS_CHANGED';

CREATE TABLE IF NOT EXISTS "TenantCronThreshold" (
  "id"                       TEXT NOT NULL,
  "tenantId"                 TEXT NOT NULL,
  "adherenceThreshold"       DOUBLE PRECISION,
  "ackRateThreshold"         DOUBLE PRECISION,
  "staleThresholdHours"      INTEGER,
  "minDeadlinedSends"        INTEGER,
  "minEscalatedForAlert"     INTEGER,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  "updatedByMembershipId"    TEXT,
  CONSTRAINT "TenantCronThreshold_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantCronThreshold_tenantId_key"
  ON "TenantCronThreshold"("tenantId");

ALTER TABLE "TenantCronThreshold"
  ADD CONSTRAINT "TenantCronThreshold_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
