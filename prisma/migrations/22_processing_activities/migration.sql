-- PRD §12.1 Controller / Processor Map. Published, product-wide table —
-- every Client sees the same rows; per-tenant applicability is computed at
-- read time from tenant flags (Sales Identifier on/off, XCL opt-in, voice
-- authorised, partner type). Same global-data pattern as Sub-Processors
-- (§15.3), Roadmap (§16), Risks (§17), Integrations (§10): no tenantId,
-- NOT under RLS, mutations gated by the page handler to Acumon operators,
-- audit events on the operator's tenant chain.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'PROCESSING_ACTIVITY_ADDED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'PROCESSING_ACTIVITY_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'PROCESSING_ACTIVITY_REMOVED';

CREATE TABLE IF NOT EXISTS "ProcessingActivity" (
  "id"                TEXT PRIMARY KEY,
  "code"              TEXT NOT NULL,
  "ordinal"           INTEGER NOT NULL,
  "label"             TEXT NOT NULL,
  "controller"        TEXT NOT NULL,
  "processor"         TEXT NOT NULL,
  "lawfulBasis"       TEXT,
  "contract"          TEXT,
  "processesPersonal" BOOLEAN NOT NULL DEFAULT true,
  "processesSpecial"  BOOLEAN NOT NULL DEFAULT false,
  "applicabilityFlag" TEXT,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProcessingActivity_code_key" ON "ProcessingActivity"("code");
CREATE INDEX IF NOT EXISTS "ProcessingActivity_ordinal_idx" ON "ProcessingActivity"("ordinal");

-- Seed the v1 PRD §12.1 table verbatim. Stable IDs so re-runs are no-ops.
INSERT INTO "ProcessingActivity"
  ("id","code","ordinal","label","controller","processor","lawfulBasis","contract","processesPersonal","processesSpecial","applicabilityFlag","notes","updatedAt")
VALUES
  ('proc-core', 'core', 0,
    'Core service (drafting, culture guides, dashboards)',
    'Client',
    'Acumon Intelligence',
    'Legitimate interests + consent (performance dashboards / sentiment monitoring of outgoing comms)',
    'Standard DPA',
    true, false,
    'always',
    'EU/UK SCCs not required (in-region inference). Active for every Client.',
    CURRENT_TIMESTAMP),

  ('proc-xcl', 'xcl', 1,
    'Cross-Client Learning',
    'Acumon Intelligence (independent controller)',
    '—',
    'Consent',
    'Separate addendum + privacy notice update by Client',
    true, false,
    'crossClientLearningOptedIn',
    'PRD §11.2 — Acumon takes a different controller position from the core service. Opt-in is recorded on Tenant.crossClientLearningOptedInAt with addendum reference.',
    CURRENT_TIMESTAMP),

  ('proc-si-intra', 'si-intra', 2,
    'Sales Identifier (intra-tenant)',
    'Client',
    'Acumon Intelligence',
    'Legitimate interests + Sales Identifier addendum',
    'Standard DPA + Sales Identifier addendum',
    true, false,
    'salesIdentifierEnabled',
    'Default Partner is Acumon Intelligence per A5. PRD §8.5 lawful-basis attestation gates the detector.',
    CURRENT_TIMESTAMP),

  ('proc-si-third', 'si-third-party', 3,
    'Sales Identifier (Partner = third party)',
    'Client + third party (joint)',
    'Acumon Intelligence',
    'Legitimate interests + tripartite agreement',
    'Tripartite agreement',
    true, false,
    'salesIdentifierThirdParty',
    'Joint controllership with the third-party Partner. Tripartite agreement required before activation.',
    CURRENT_TIMESTAMP),

  ('proc-auth', 'auth', 4,
    'Authentication / SSO',
    'Client',
    'Acumon (+ identity sub-processor)',
    'Contract',
    'Listed sub-processor',
    true, false,
    'always',
    'Identity sub-processor declared on /switching per §15.3.',
    CURRENT_TIMESTAMP),

  ('proc-voice', 'voice', 5,
    'Voice transcription',
    'Client',
    'Acumon (+ transcription sub-processor, in-region)',
    'Legitimate interests + consent (per User opt-in)',
    'Listed sub-processor',
    true, true,
    'voiceAuthorised',
    'PRD §13.5 voice-input feature. Special-category if recordings expose health, religion etc. — flagged for caution. Raw audio retained 30 days per §12.5.',
    CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
