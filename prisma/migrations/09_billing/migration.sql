-- Billing module (PRD §15.1 Pricing Structure + §15.2 Inactive and Edge-Case
-- Users). One BillingPeriod per tenant per calendar month, with per-User
-- snapshots that capture the §15.2 "active" determination so the resulting
-- invoice is explainable line by line.
--
-- Pricing fields live on Tenant (one plan per client); they are mutable but
-- every change is audited (BILLING_PLAN_UPDATED). When a period is closed,
-- the full plan + line items are snapshotted into BillingPeriod.payload so
-- the invoice survives subsequent plan changes.
--
-- `Membership.lastLoginAt` is the §15.2 "logged in within the billing month"
-- signal, stamped by getTenantContext on every authed page resolution.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'BILLING_PLAN_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'BILLING_PERIOD_CLOSED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'BILLING_PERIOD_REOPENED';

DO $$ BEGIN
  CREATE TYPE "BillingPeriodStatus" AS ENUM ('DRAFT', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "pricingCurrency"                  TEXT    NOT NULL DEFAULT 'GBP',
  ADD COLUMN IF NOT EXISTS "pricingBaseMinor"                 INTEGER NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS "pricingSalesIdMinor"              INTEGER NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS "pricingSalesIdPartnerDefault"     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "pricingSalesIdPartnerDiscountPct" INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS "pricingCrossClientLearningOptIn"  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "pricingCclDiscountPct"            INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "pricingCmkEnabled"                BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "pricingCmkMinor"                  INTEGER NOT NULL DEFAULT 50000,
  ADD COLUMN IF NOT EXISTS "sandboxBillingFreeUntil"          TIMESTAMP(3);

ALTER TABLE "Membership"
  ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Membership_tenantId_lastLoginAt_idx"
  ON "Membership"("tenantId", "lastLoginAt");

CREATE TABLE IF NOT EXISTS "BillingPeriod" (
  "id"                   TEXT NOT NULL,
  "tenantId"             TEXT NOT NULL,
  "period"               TEXT NOT NULL,
  "status"               "BillingPeriodStatus" NOT NULL DEFAULT 'DRAFT',
  "closedAt"             TIMESTAMP(3),
  "closedByMembershipId" TEXT,
  "currency"             TEXT NOT NULL DEFAULT 'GBP',
  "activeUsers"          INTEGER NOT NULL DEFAULT 0,
  "billableUsers"        INTEGER NOT NULL DEFAULT 0,
  "salesIdUsers"         INTEGER NOT NULL DEFAULT 0,
  "baseSubtotalMinor"    INTEGER NOT NULL DEFAULT 0,
  "salesIdSubtotalMinor" INTEGER NOT NULL DEFAULT 0,
  "cmkSubtotalMinor"     INTEGER NOT NULL DEFAULT 0,
  "totalMinor"           INTEGER NOT NULL DEFAULT 0,
  "payload"              JSONB NOT NULL,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingPeriod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BillingPeriod_tenantId_period_key"
  ON "BillingPeriod"("tenantId", "period");
CREATE INDEX IF NOT EXISTS "BillingPeriod_tenantId_status_idx"
  ON "BillingPeriod"("tenantId", "status");

DO $$ BEGIN
  ALTER TABLE "BillingPeriod"
    ADD CONSTRAINT "BillingPeriod_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "BillingUserSnapshot" (
  "id"                     TEXT NOT NULL,
  "tenantId"               TEXT NOT NULL,
  "periodId"               TEXT NOT NULL,
  "membershipId"           TEXT,
  "userEmail"              TEXT NOT NULL,
  "role"                   "Role" NOT NULL,
  "membershipStatus"       "MembershipStatus" NOT NULL,
  "hasAuthorisedChannel"   BOOLEAN NOT NULL DEFAULT FALSE,
  "loggedInThisPeriod"     BOOLEAN NOT NULL DEFAULT FALSE,
  "hadDraftThisPeriod"     BOOLEAN NOT NULL DEFAULT FALSE,
  "draftCount"             INTEGER NOT NULL DEFAULT 0,
  "isActiveByPRD"          BOOLEAN NOT NULL DEFAULT FALSE,
  "isBillable"             BOOLEAN NOT NULL DEFAULT FALSE,
  "salesIdentifierApplies" BOOLEAN NOT NULL DEFAULT FALSE,
  "reason"                 TEXT NOT NULL DEFAULT '',
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingUserSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BillingUserSnapshot_tenantId_periodId_idx"
  ON "BillingUserSnapshot"("tenantId", "periodId");
CREATE INDEX IF NOT EXISTS "BillingUserSnapshot_periodId_isBillable_idx"
  ON "BillingUserSnapshot"("periodId", "isBillable");

DO $$ BEGIN
  ALTER TABLE "BillingUserSnapshot"
    ADD CONSTRAINT "BillingUserSnapshot_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BillingUserSnapshot"
    ADD CONSTRAINT "BillingUserSnapshot_periodId_fkey"
    FOREIGN KEY ("periodId") REFERENCES "BillingPeriod"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BillingUserSnapshot"
    ADD CONSTRAINT "BillingUserSnapshot_membershipId_fkey"
    FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
