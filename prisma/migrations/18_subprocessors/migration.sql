-- PRD §15.3 Switching and Lock-In Posture — sub-processor list. Global
-- table (not tenant-scoped, NOT under RLS) so every Client and prospective
-- Client sees the same list. Same shape as Roadmap (§16) and Risks (§17):
-- mutations gated by the page handler to Acumon-tenant operators.
--
-- The migration seeds the v1 sub-processor list reflecting what's actually
-- in the production stack (LLM providers used, Railway hosting, the SMTP
-- transport for verification emails). Operators amend / extend through the
-- /switching page after deployment.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_ADDED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_REMOVED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SUBPROCESSOR_REINSTATED';

CREATE TABLE IF NOT EXISTS "SubProcessor" (
  "id"             TEXT PRIMARY KEY,
  "code"           TEXT NOT NULL,
  "ordinal"        INTEGER NOT NULL,
  "name"           TEXT NOT NULL,
  "role"           TEXT NOT NULL,
  "jurisdiction"   TEXT NOT NULL,
  "dataCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "contractRef"    TEXT,
  "notes"          TEXT,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "addedAt"        TIMESTAMP(3) NOT NULL,
  "removedAt"      TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "SubProcessor_code_key" ON "SubProcessor"("code");
CREATE INDEX IF NOT EXISTS "SubProcessor_isActive_ordinal_idx"
  ON "SubProcessor"("isActive", "ordinal");
CREATE INDEX IF NOT EXISTS "SubProcessor_ordinal_idx" ON "SubProcessor"("ordinal");

-- Seed v1 sub-processors. Stable IDs so re-running the migration is a no-op.
INSERT INTO "SubProcessor" ("id", "code", "ordinal", "name", "role", "jurisdiction", "dataCategories", "addedAt", "updatedAt")
VALUES
  ('subp-anthropic',  'anthropic', 0, 'Anthropic',  'LLM provider — Compliance Judge + statutory verifier', 'US',
    ARRAY['Drafts', 'FCG/UCG content', 'Compliance rulings'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('subp-together',   'together',  1, 'Together AI', 'LLM provider — drafting, sentiment, opportunity, meeting agents', 'US',
    ARRAY['Drafts', 'Inbound message snippets', 'FCG/UCG content'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('subp-railway',    'railway',   2, 'Railway',     'Application hosting + managed Postgres',          'US',
    ARRAY['All tenant data at rest'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('subp-resend',     'smtp',      3, 'SMTP transport (operator-configured)', 'Verification emails + transactional notifications', 'Operator-selected',
    ARRAY['User email addresses', 'Verification tokens'], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
