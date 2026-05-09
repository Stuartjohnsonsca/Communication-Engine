-- PRD §11 Cross-Client Learning. Adds:
--   * Per-tenant attestation columns capturing the §11.2 opt-in addendum
--     (who signed, when, the document reference) — separate from the
--     existing `pricingCrossClientLearningOptIn` boolean which is the gate
--     itself. Opt-out is recorded as well so the audit trail keeps history.
--   * Two global tables for the curator pipeline:
--       - XclCandidate         (PRD §11.3 anonymisation pipeline + curator review)
--       - XclReidentificationTest (PRD §11.3 quarterly re-id test log)
--     Both are global (no tenantId, NOT under RLS): per PRD §11.2 Acumon
--     acts as independent controller for XCL processing, so the curator
--     queue is necessarily cross-tenant.
--   * New audit event types for opt-in/out, candidate lifecycle, and the
--     re-identification test log.

-- ─── Enums ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'XclInsightKind') THEN
    CREATE TYPE "XclInsightKind" AS ENUM ('FCG_AMENDMENT', 'OPPORTUNITY_RULE', 'JUDGE_PROMPT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'XclCandidateStatus') THEN
    CREATE TYPE "XclCandidateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMMITTED');
  END IF;
END $$;

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'XCL_OPT_IN';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'XCL_OPT_OUT';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'XCL_CANDIDATE_PROPOSED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'XCL_CANDIDATE_APPROVED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'XCL_CANDIDATE_REJECTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'XCL_CANDIDATE_COMMITTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'XCL_REID_TEST_RECORDED';

-- ─── Tenant columns ────────────────────────────────────────────────────────

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "crossClientLearningOptedInAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "crossClientLearningOptedInByName" TEXT,
  ADD COLUMN IF NOT EXISTS "crossClientLearningAddendumRef"   TEXT,
  ADD COLUMN IF NOT EXISTS "crossClientLearningOptedOutAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "crossClientLearningOptedOutReason" TEXT;

-- ─── XclCandidate ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "XclCandidate" (
  "id"                  TEXT PRIMARY KEY,
  "sourceTenantId"      TEXT NOT NULL,
  "sourceSubjectType"   TEXT NOT NULL,
  "sourceSubjectId"     TEXT NOT NULL,
  "kind"                "XclInsightKind"     NOT NULL,
  "status"              "XclCandidateStatus" NOT NULL DEFAULT 'PENDING',
  "originalText"        TEXT NOT NULL,
  "redactedText"        TEXT NOT NULL,
  "redactionLog"        JSONB NOT NULL,
  "curatorMembershipId" TEXT,
  "curatorTenantId"     TEXT,
  "curatorDecidedAt"    TIMESTAMP(3),
  "curatorNotes"        TEXT,
  "committedAt"         TIMESTAMP(3),
  "committedByName"     TEXT,
  "declines"            JSONB NOT NULL DEFAULT '[]',
  "modelRunId"          TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "XclCandidate_status_idx"          ON "XclCandidate"("status");
CREATE INDEX IF NOT EXISTS "XclCandidate_sourceTenantId_idx"  ON "XclCandidate"("sourceTenantId");
CREATE INDEX IF NOT EXISTS "XclCandidate_kind_status_idx"     ON "XclCandidate"("kind", "status");

-- ─── XclReidentificationTest ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "XclReidentificationTest" (
  "id"                TEXT PRIMARY KEY,
  "quarter"           TEXT NOT NULL,
  "conductedAt"       TIMESTAMP(3) NOT NULL,
  "conductedByName"   TEXT NOT NULL,
  "externalReviewer"  BOOLEAN NOT NULL DEFAULT true,
  "sampleSize"        INTEGER NOT NULL,
  "reidentifiedCount" INTEGER NOT NULL DEFAULT 0,
  "summary"           TEXT NOT NULL,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "XclReidentificationTest_quarter_key"
  ON "XclReidentificationTest"("quarter");

CREATE INDEX IF NOT EXISTS "XclReidentificationTest_conductedAt_idx"
  ON "XclReidentificationTest"("conductedAt");
