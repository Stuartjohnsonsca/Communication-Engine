-- Open Questions for Sign-Off (PRD §18). Ten product / legal / commercial
-- questions enumerated verbatim in the PRD body that need an explicit decision
-- before GA. Intentionally NOT a §15.3 transparency surface — these are the
-- decisions still under deliberation, not the published commitments. Read AND
-- write are restricted to operators of the "acumon" tenant (FIRM_ADMIN there
-- or ACUMON_ADMIN globally). The page handler enforces the tenant-slug gate;
-- the row is global (no tenantId) and lives outside RLS — see prisma/rls.sql.
--
-- Each row carries the original PRD-side assumption hint (the parenthetical
-- in the question) so an operator can see what the working default was when
-- the question was raised. Once decided, the decision text + decidedByName +
-- decidedAt are written; the audit chain captures the change against the
-- operator's tenant.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SIGNOFF_QUESTION_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SIGNOFF_QUESTION_DECIDED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SIGNOFF_QUESTION_REOPENED';

DO $$ BEGIN
  CREATE TYPE "SignOffStatus" AS ENUM ('OPEN', 'DECIDED', 'DEFERRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SignOffQuestion" (
  "id"            TEXT NOT NULL,
  "code"          TEXT NOT NULL,
  "ordinal"       INTEGER NOT NULL,
  "question"      TEXT NOT NULL,
  "prdAssumption" TEXT,
  "status"        "SignOffStatus" NOT NULL DEFAULT 'OPEN',
  "decision"      TEXT,
  "decidedAt"     TIMESTAMP(3),
  "decidedByName" TEXT,
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SignOffQuestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SignOffQuestion_code_key" ON "SignOffQuestion"("code");
CREATE INDEX IF NOT EXISTS "SignOffQuestion_ordinal_idx" ON "SignOffQuestion"("ordinal");
CREATE INDEX IF NOT EXISTS "SignOffQuestion_status_idx" ON "SignOffQuestion"("status");

-- ─── Seed: PRD §18 questions, verbatim, in PRD order. Idempotent on `code`.
-- Static columns (question, prdAssumption, ordinal) are overwritten on conflict
-- so a PRD revision propagates; operator decision columns (status, decision,
-- decidedAt, decidedByName, notes) are preserved.

INSERT INTO "SignOffQuestion" ("id", "code", "ordinal", "question", "prdAssumption", "updatedAt")
VALUES
  ('signoff-q-01', 'Q-01', 0,
    'Confirm controller / processor model for the core service.',
    'PRD assumption A1.',
    CURRENT_TIMESTAMP),
  ('signoff-q-02', 'Q-02', 1,
    'Confirm the User Culture Guide retention period post-departure.',
    'Default 30 days, anonymise or delete.',
    CURRENT_TIMESTAMP),
  ('signoff-q-03', 'Q-03', 2,
    'Confirm quorum default and the Emergency amendment window.',
    'Simple majority of total membership; 24-hour Emergency window.',
    CURRENT_TIMESTAMP),
  ('signoff-q-04', 'Q-04', 3,
    'Confirm Sales Identifier Partner pricing structure.',
    'Default discount; Client-as-Partner free; third-party fee.',
    CURRENT_TIMESTAMP),
  ('signoff-q-05', 'Q-05', 4,
    'Confirm jurisdictional split for EU residency.',
    'Single EU region (Ireland) or Client-selected (Ireland / Frankfurt / Paris).',
    CURRENT_TIMESTAMP),
  ('signoff-q-06', 'Q-06', 5,
    'Confirm whether voice transcription has an in-region sub-processor available for all v1 jurisdictions, or whether voice is held back to P2.',
    NULL,
    CURRENT_TIMESTAMP),
  ('signoff-q-07', 'Q-07', 6,
    'Confirm position on personal WhatsApp.',
    'Excluded by design (recommended) versus opt-in by User.',
    CURRENT_TIMESTAMP),
  ('signoff-q-08', 'Q-08', 7,
    'Confirm certifications budget and timeline.',
    'ISO 27001 + Cyber Essentials Plus by GA — aggressive.',
    CURRENT_TIMESTAMP),
  ('signoff-q-09', 'Q-09', 8,
    'Confirm pilot scope and timing for Acumon Intelligence as Pilot Client.',
    NULL,
    CURRENT_TIMESTAMP),
  ('signoff-q-10', 'Q-10', 9,
    'Confirm pricing tiers and the discount values.',
    'Acumon-as-default-Partner; Cross-Client Learning opt-in.',
    CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET
  "ordinal"       = EXCLUDED."ordinal",
  "question"      = EXCLUDED."question",
  "prdAssumption" = EXCLUDED."prdAssumption",
  "updatedAt"     = CURRENT_TIMESTAMP;
