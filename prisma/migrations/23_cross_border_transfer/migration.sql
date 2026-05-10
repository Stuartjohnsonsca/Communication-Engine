-- PRD §12.6 Cross-Border Transfer. The system blocks activation of any
-- third-country sub-processor until SCCs and a documented Transfer Impact
-- Assessment are in place for that tenant × sub-processor pair.
--
-- The global SubProcessor table (§15.3) is the catalogue; this per-tenant
-- table is the per-Client authorisation layer. UK + EU sub-processors don't
-- need a TIA — activation gate only fires for non-EU/UK rows.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TIA_RECORDED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TIA_REVOKED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TIA_EXPIRED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TIAStatus') THEN
    CREATE TYPE "TIAStatus" AS ENUM ('RECORDED', 'EXPIRED', 'REVOKED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "TransferImpactAssessment" (
  "id"               TEXT PRIMARY KEY,
  "tenantId"         TEXT NOT NULL,
  "subProcessorCode" TEXT NOT NULL,
  "status"           "TIAStatus" NOT NULL DEFAULT 'RECORDED',
  "sccDocumentRef"   TEXT NOT NULL,
  "tiaDocumentRef"   TEXT NOT NULL,
  "effectiveFrom"    TIMESTAMP(3) NOT NULL,
  "effectiveTo"      TIMESTAMP(3) NOT NULL,
  "signedByName"     TEXT NOT NULL,
  "signedByRole"     TEXT NOT NULL,
  "dataCategories"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "notes"            TEXT,
  "revokedAt"        TIMESTAMP(3),
  "revokedReason"    TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TransferImpactAssessment_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "TransferImpactAssessment_tenant_sub_from_key"
  ON "TransferImpactAssessment"("tenantId","subProcessorCode","effectiveFrom");
CREATE INDEX IF NOT EXISTS "TransferImpactAssessment_tenant_status_idx"
  ON "TransferImpactAssessment"("tenantId","status");
CREATE INDEX IF NOT EXISTS "TransferImpactAssessment_tenant_sub_idx"
  ON "TransferImpactAssessment"("tenantId","subProcessorCode");
CREATE INDEX IF NOT EXISTS "TransferImpactAssessment_effectiveTo_idx"
  ON "TransferImpactAssessment"("effectiveTo");
