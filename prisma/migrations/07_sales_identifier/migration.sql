-- Sales Identifier (PRD §8). Enables the opt-in revenue-opportunity add-on:
-- a tenant-level enable flag plus a separate lawful-basis attestation
-- (PRD §8.5: mining counterparty correspondence is a separate processing
-- purpose), the OpportunityCandidate enrichments needed to support the
-- reviewer console (accept/revise/reject/route-to-Partner), and a per-
-- candidate comment thread.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SALES_IDENTIFIER_ENABLED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SALES_IDENTIFIER_DISABLED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SI_LAWFUL_BASIS_ATTESTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'OPPORTUNITY_DETECTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'OPPORTUNITY_ACCEPTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'OPPORTUNITY_REVISED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'OPPORTUNITY_REJECTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'OPPORTUNITY_ROUTED_TO_PARTNER';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'OPPORTUNITY_COMMENTED';

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "salesIdentifierEnabled"               BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "salesIdentifierEnabledAt"             TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "salesIdentifierLawfulBasisAttestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "salesIdentifierLawfulBasisAttestedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "salesIdentifierLawfulBasisNote"       TEXT;

ALTER TABLE "OpportunityCandidate"
  ADD COLUMN IF NOT EXISTS "sourceIngestedMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "signalQuotes"            JSONB,
  ADD COLUMN IF NOT EXISTS "suggestedReviewerTeam"   TEXT,
  ADD COLUMN IF NOT EXISTS "modelRunId"              TEXT,
  ADD COLUMN IF NOT EXISTS "decidedAt"               TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "decidedByMembershipId"   TEXT,
  ADD COLUMN IF NOT EXISTS "decisionReason"          TEXT,
  ADD COLUMN IF NOT EXISTS "routeNotes"              TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OpportunityCandidate_sourceIngestedMessageId_fkey'
  ) THEN
    ALTER TABLE "OpportunityCandidate"
      ADD CONSTRAINT "OpportunityCandidate_sourceIngestedMessageId_fkey"
      FOREIGN KEY ("sourceIngestedMessageId") REFERENCES "IngestedMessage"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OpportunityCandidate_decidedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "OpportunityCandidate"
      ADD CONSTRAINT "OpportunityCandidate_decidedByMembershipId_fkey"
      FOREIGN KEY ("decidedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "OpportunityCandidate_tenantId_reviewerMembershipId_status_idx"
  ON "OpportunityCandidate"("tenantId", "reviewerMembershipId", "status");

CREATE TABLE IF NOT EXISTS "OpportunityComment" (
  "id"                 TEXT PRIMARY KEY,
  "tenantId"           TEXT NOT NULL,
  "candidateId"        TEXT NOT NULL,
  "authorMembershipId" TEXT NOT NULL,
  "body"               TEXT NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OpportunityComment_candidateId_fkey'
  ) THEN
    ALTER TABLE "OpportunityComment"
      ADD CONSTRAINT "OpportunityComment_candidateId_fkey"
      FOREIGN KEY ("candidateId") REFERENCES "OpportunityCandidate"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OpportunityComment_authorMembershipId_fkey'
  ) THEN
    ALTER TABLE "OpportunityComment"
      ADD CONSTRAINT "OpportunityComment_authorMembershipId_fkey"
      FOREIGN KEY ("authorMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "OpportunityComment_tenantId_candidateId_idx"
  ON "OpportunityComment"("tenantId", "candidateId");
