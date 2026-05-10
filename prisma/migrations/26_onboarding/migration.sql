-- PRD §14.1 Client Onboarding. Tenant-level phase + per-step manual ticks
-- for steps the platform cannot itself detect.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ONBOARDING_STEP_TICKED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ONBOARDING_STEP_UNTICKED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ONBOARDING_PHASE_CHANGED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ONBOARDING_COMPLETED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OnboardingPhase') THEN
    CREATE TYPE "OnboardingPhase" AS ENUM (
      'COMMERCIAL','TECHNICAL','COMPLIANCE','CONFIGURATION','PILOT','PRODUCTION','LIVE'
    );
  END IF;
END $$;

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "onboardingPhase" "OnboardingPhase" NOT NULL DEFAULT 'COMMERCIAL',
  ADD COLUMN IF NOT EXISTS "onboardingStartedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "onboardingCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "onboardingNotes"       TEXT;

CREATE TABLE IF NOT EXISTS "OnboardingChecklistItem" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "phase"         "OnboardingPhase" NOT NULL,
  "code"          TEXT NOT NULL,
  "checked"       BOOLEAN NOT NULL DEFAULT false,
  "checkedAt"     TIMESTAMP(3),
  "checkedByName" TEXT,
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OnboardingChecklistItem_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "OnboardingChecklistItem_tenant_code_key"
  ON "OnboardingChecklistItem"("tenantId","code");
CREATE INDEX IF NOT EXISTS "OnboardingChecklistItem_tenant_phase_idx"
  ON "OnboardingChecklistItem"("tenantId","phase");

-- Existing tenants are mid-build, not in onboarding mode; mark them LIVE
-- so the new tab on the layout doesn't show "still onboarding" for the
-- pilot tenant or for tenants that were provisioned before this module
-- existed. The Acumon tenant in particular has been LIVE since project
-- inception. New tenants come in at COMMERCIAL via the schema default.
UPDATE "Tenant" SET
  "onboardingPhase" = 'LIVE',
  "onboardingCompletedAt" = COALESCE("onboardingCompletedAt", CURRENT_TIMESTAMP)
WHERE "createdAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'
  AND "onboardingPhase" = 'COMMERCIAL';
