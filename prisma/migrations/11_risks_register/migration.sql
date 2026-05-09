-- Risks Register module (PRD §17 Risks and Mitigations). Global product-level
-- risks register: same eleven risks for every tenant, mirroring the §17 PRD
-- table verbatim. An Acumon operator can change status / severity, edit the
-- mitigation list, add notes, and tick a periodic-review timestamp.
--
-- Risk rows are intentionally NOT tenant-scoped: published to every Client per
-- PRD §15.3 transparency posture (sub-processor list, integration APIs, export
-- schemas… and the product's risk register). Audit events for status changes
-- and reviews are written against the operator's own tenant chain.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'RISK_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'RISK_REVIEWED';

DO $$ BEGIN
  CREATE TYPE "RiskSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "RiskStatus" AS ENUM ('ACTIVE', 'MITIGATED', 'ACCEPTED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Risk" (
  "id"             TEXT NOT NULL,
  "code"           TEXT NOT NULL,
  "ordinal"        INTEGER NOT NULL,
  "title"          TEXT NOT NULL,
  "severity"       "RiskSeverity" NOT NULL,
  "status"         "RiskStatus" NOT NULL DEFAULT 'ACTIVE',
  "mitigations"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "notes"          TEXT,
  "reviewedAt"     TIMESTAMP(3),
  "reviewedByName" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Risk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Risk_code_key" ON "Risk"("code");
CREATE INDEX IF NOT EXISTS "Risk_ordinal_idx" ON "Risk"("ordinal");
CREATE INDEX IF NOT EXISTS "Risk_severity_status_idx" ON "Risk"("severity", "status");

-- ─── Seed: PRD §17 risks. Idempotent on `code`. Updates rewrite the PRD-static
-- copy (title / severity / mitigations / ordinal) so a PRD revision applied
-- later overwrites the canonical content; `status`, `notes`, `reviewedAt`,
-- `reviewedByName` are preserved because they capture operator decisions.

INSERT INTO "Risk" ("id", "code", "ordinal", "title", "severity", "mitigations", "updatedAt")
VALUES
  ('risk-r-01', 'R-01', 0,
    'Lawful basis for staff monitoring challenged by employee or regulator',
    'HIGH',
    ARRAY[
      'Strict legitimate-interests + opt-in split',
      'ICO worker-monitoring guidance baked into product',
      'Performance data delayed and opt-in',
      'Article 22 safeguards'
    ],
    CURRENT_TIMESTAMP),
  ('risk-r-02', 'R-02', 1,
    'EU AI Act provider obligations underestimated',
    'HIGH',
    ARRAY[
      'Treat as high-risk from day one',
      'Conformity assessment as P4 milestone',
      'Risk management system in place from P0'
    ],
    CURRENT_TIMESTAMP),
  ('risk-r-03', 'R-03', 2,
    'Hallucination in technical drafts causes professional negligence claim',
    'HIGH',
    ARRAY[
      'Drafting-only posture',
      'Mandatory citation',
      'Statutory verifier',
      'No-go list',
      '"Holding draft" fallback when grounding fails'
    ],
    CURRENT_TIMESTAMP),
  ('risk-r-04', 'R-04', 3,
    'Cross-tenant data leak',
    'HIGH',
    ARRAY[
      'Per-tenant cryptographic isolation',
      'Cross-tenant access alerting',
      'Quarterly penetration test',
      'CMK option'
    ],
    CURRENT_TIMESTAMP),
  ('risk-r-05', 'R-05', 4,
    'Counterparty DSAR exposes firm advice to a third party',
    'MEDIUM',
    ARRAY[
      'DSAR module routes to Client',
      'Client decides what is and is not in scope',
      'Logging of decisions'
    ],
    CURRENT_TIMESTAMP),
  ('risk-r-06', 'R-06', 5,
    'Partner-default arrangement seen as anti-competitive tying',
    'MEDIUM',
    ARRAY[
      'Frame as discount for default rather than penalty for switching',
      'Client-as-Partner included free',
      'Legal review'
    ],
    CURRENT_TIMESTAMP),
  ('risk-r-07', 'R-07', 6,
    'Sales Identifier mining of client correspondence breaches counterparty privacy notice',
    'MEDIUM',
    ARRAY[
      'Lawful-basis assessment per Client',
      'Template privacy notice updates',
      'Opt-in toggling'
    ],
    CURRENT_TIMESTAMP),
  ('risk-r-08', 'R-08', 7,
    'WhatsApp scanning conflates personal and business messages',
    'MEDIUM',
    ARRAY[
      'Only WhatsApp Business deployments supported',
      'Personal channels excluded by policy and by integration design'
    ],
    CURRENT_TIMESTAMP),
  ('risk-r-09', 'R-09', 8,
    'LLM-as-judge produces inconsistent compliance rulings',
    'MEDIUM',
    ARRAY[
      'Appeal path',
      'FCT override authority',
      'Curator monitoring',
      'Periodic eval set'
    ],
    CURRENT_TIMESTAMP),
  ('risk-r-10', 'R-10', 9,
    'Frontier model provider changes terms or region availability',
    'MEDIUM',
    ARRAY[
      'Multi-vendor abstraction layer',
      'In-region commitments contractual',
      'Fallback model maintained'
    ],
    CURRENT_TIMESTAMP),
  ('risk-r-11', 'R-11', 10,
    'Auto-integration capability over-promised in marketing',
    'LOW',
    ARRAY[
      'PRD positions auto-integration as roadmap',
      'SDK + managed-onboarding service shipped instead'
    ],
    CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET
  "ordinal"     = EXCLUDED."ordinal",
  "title"       = EXCLUDED."title",
  "severity"    = EXCLUDED."severity",
  "mitigations" = EXCLUDED."mitigations",
  "updatedAt"   = CURRENT_TIMESTAMP;
