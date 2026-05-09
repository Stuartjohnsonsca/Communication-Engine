-- Roadmap module (PRD §16 Roadmap and Phasing). Global product-roadmap
-- table — same five phases (P0–P4) for every tenant — with an exit-criteria
-- child table the Acumon operator can tick off as criteria are met.
--
-- Roadmap rows are intentionally NOT tenant-scoped: the same posture page
-- appears for every Client per PRD §15.3 ("publishes its sub-processor list,
-- integration APIs and export schemas in advance of contracting"). Audit
-- events for status changes are written against the operator's tenant.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ROADMAP_PHASE_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ROADMAP_EXIT_CRITERION_MET';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ROADMAP_EXIT_CRITERION_UNMET';

DO $$ BEGIN
  CREATE TYPE "RoadmapPhaseStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "RoadmapPhase" (
  "id"                TEXT NOT NULL,
  "code"              TEXT NOT NULL,
  "ordinal"           INTEGER NOT NULL,
  "name"              TEXT NOT NULL,
  "windowMonthsStart" INTEGER NOT NULL,
  "windowMonthsEnd"   INTEGER NOT NULL,
  "status"            "RoadmapPhaseStatus" NOT NULL DEFAULT 'PLANNED',
  "scope"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "notes"             TEXT,
  "startedAt"         TIMESTAMP(3),
  "completedAt"       TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RoadmapPhase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RoadmapPhase_code_key" ON "RoadmapPhase"("code");
CREATE INDEX IF NOT EXISTS "RoadmapPhase_ordinal_idx" ON "RoadmapPhase"("ordinal");

CREATE TABLE IF NOT EXISTS "RoadmapExitCriterion" (
  "id"        TEXT NOT NULL,
  "phaseId"   TEXT NOT NULL,
  "ordinal"   INTEGER NOT NULL,
  "text"      TEXT NOT NULL,
  "metAt"     TIMESTAMP(3),
  "metByName" TEXT,
  "notes"     TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RoadmapExitCriterion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RoadmapExitCriterion_phaseId_ordinal_idx"
  ON "RoadmapExitCriterion"("phaseId", "ordinal");

DO $$ BEGIN
  ALTER TABLE "RoadmapExitCriterion"
    ADD CONSTRAINT "RoadmapExitCriterion_phaseId_fkey"
    FOREIGN KEY ("phaseId") REFERENCES "RoadmapPhase"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Seed: PRD §16 phases. Idempotent on `code`. Updates rewrite the static
-- copy (name/scope/window) so a PRD revision applied later overwrites the
-- canonical content; `status`, `notes`, `startedAt`, `completedAt` are
-- preserved because they capture operator-recorded progress.

INSERT INTO "RoadmapPhase" ("id", "code", "ordinal", "name", "windowMonthsStart", "windowMonthsEnd", "scope", "updatedAt")
VALUES
  ('roadmap-phase-p0', 'P0', 0, 'Internal Pilot (Acumon Intelligence)', 0, 4,
    ARRAY['Tenant infra', 'FCG/UCG core', 'M365 + Google + Slack integrations', 'Drafting', 'Audit log', 'DPIA Helper'],
    CURRENT_TIMESTAMP),
  ('roadmap-phase-p1', 'P1', 1, 'General Availability', 4, 9,
    ARRAY['Multi-tenant onboarding', 'Sandbox', 'Performance dashboards (opt-in)', 'Sentiment monitoring', 'Voice input', 'ISO 27001 + Cyber Essentials Plus'],
    CURRENT_TIMESTAMP),
  ('roadmap-phase-p2', 'P2', 2, 'Sales Identifier', 9, 14,
    ARRAY['Sales Identifier add-on', 'Partner routing', 'Cross-Client Learning v1', 'Jurisdiction knowledge ingestion (UK + Ireland)'],
    CURRENT_TIMESTAMP),
  ('roadmap-phase-p3', 'P3', 3, 'EU Expansion and Multi-Language', 12, 18,
    ARRAY['EU residency option', 'Multi-language drafting', 'Additional jurisdictions', 'Tier 2 integrations', 'SOC 2 Type II'],
    CURRENT_TIMESTAMP),
  ('roadmap-phase-p4', 'P4', 4, 'Enterprise & AI Act conformity', 18, 24,
    ARRAY['BYOK / CMK', 'ISO 27701 + 42001', 'Full EU AI Act conformity assessment and CE marking', 'Generic Integration SDK GA'],
    CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET
  "ordinal"           = EXCLUDED."ordinal",
  "name"              = EXCLUDED."name",
  "windowMonthsStart" = EXCLUDED."windowMonthsStart",
  "windowMonthsEnd"   = EXCLUDED."windowMonthsEnd",
  "scope"             = EXCLUDED."scope",
  "updatedAt"         = CURRENT_TIMESTAMP;

INSERT INTO "RoadmapExitCriterion" ("id", "phaseId", "ordinal", "text", "updatedAt")
VALUES
  ('roadmap-ec-p0-1', 'roadmap-phase-p0', 0, 'Acumon goes live as Pilot Client', CURRENT_TIMESTAMP),
  ('roadmap-ec-p0-2', 'roadmap-phase-p0', 1, 'FCG approved',                     CURRENT_TIMESTAMP),
  ('roadmap-ec-p0-3', 'roadmap-phase-p0', 2, '100% staff onboarded',             CURRENT_TIMESTAMP),
  ('roadmap-ec-p1-1', 'roadmap-phase-p1', 0, 'First 3 paying Clients',           CURRENT_TIMESTAMP),
  ('roadmap-ec-p1-2', 'roadmap-phase-p1', 1, 'SLA met',                          CURRENT_TIMESTAMP),
  ('roadmap-ec-p2-1', 'roadmap-phase-p2', 0, '10+ Clients on Sales Identifier',  CURRENT_TIMESTAMP),
  ('roadmap-ec-p3-1', 'roadmap-phase-p3', 0, 'EU Clients live',                  CURRENT_TIMESTAMP),
  ('roadmap-ec-p3-2', 'roadmap-phase-p3', 1, '≥ 5 languages in production',      CURRENT_TIMESTAMP),
  ('roadmap-ec-p4-1', 'roadmap-phase-p4', 0, 'Enterprise procurement-ready',     CURRENT_TIMESTAMP),
  ('roadmap-ec-p4-2', 'roadmap-phase-p4', 1, 'AI Act compliant',                 CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE SET
  "phaseId"   = EXCLUDED."phaseId",
  "ordinal"   = EXCLUDED."ordinal",
  "text"      = EXCLUDED."text",
  "updatedAt" = CURRENT_TIMESTAMP;
