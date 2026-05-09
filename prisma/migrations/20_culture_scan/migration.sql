-- PRD §5.1.1 Firm Culture Scan. The system performs a bounded scan over FCT
-- members' communications (date range + channel scope set by the Firm
-- Administrator under DPIA) and produces a draft Firm Culture Guide covering:
-- tone, register, response-time expectations per channel, salutation and
-- sign-off conventions, escalation phrases, regulatory phrases that are
-- mandatory or prohibited, language preferences, signature-block standards.
--
-- A scan results in an FCGProposal staged for FCT review; promotion still
-- requires the normal §6 quorum vote — the scan never bypasses governance.
--
-- FirmCultureScan is added to the RLS array in `prisma/rls.sql`.

-- ─── Enum ──────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FirmCultureScanStatus') THEN
    CREATE TYPE "FirmCultureScanStatus" AS ENUM (
      'PENDING',
      'ANALYSING',
      'DRAFTED',
      'PROMOTED',
      'ERRORED',
      'DISCARDED'
    );
  END IF;
END $$;

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'FCG_SCAN_INITIATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'FCG_SCAN_COMPLETED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'FCG_SCAN_FAILED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'FCG_SCAN_PROMOTED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'FCG_SCAN_DISCARDED';

-- ─── FirmCultureScan ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "FirmCultureScan" (
  "id"               TEXT PRIMARY KEY,
  "tenantId"         TEXT NOT NULL,
  "initiatedById"    TEXT NOT NULL,
  "dateRangeFrom"    TIMESTAMP(3) NOT NULL,
  "dateRangeTo"      TIMESTAMP(3) NOT NULL,
  "channelKinds"     JSONB NOT NULL,
  "status"           "FirmCultureScanStatus" NOT NULL DEFAULT 'PENDING',
  "messagesAnalysed" INTEGER NOT NULL DEFAULT 0,
  "proposalId"       TEXT,
  "analysisResult"   JSONB,
  "errorMessage"     TEXT,
  "completedAt"      TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FirmCultureScan_tenantId_fkey'
  ) THEN
    ALTER TABLE "FirmCultureScan"
      ADD CONSTRAINT "FirmCultureScan_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FirmCultureScan_initiatedById_fkey'
  ) THEN
    ALTER TABLE "FirmCultureScan"
      ADD CONSTRAINT "FirmCultureScan_initiatedById_fkey"
      FOREIGN KEY ("initiatedById") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'FirmCultureScan_proposalId_fkey'
  ) THEN
    ALTER TABLE "FirmCultureScan"
      ADD CONSTRAINT "FirmCultureScan_proposalId_fkey"
      FOREIGN KEY ("proposalId") REFERENCES "FCGProposal"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "FirmCultureScan_tenantId_status_idx"
  ON "FirmCultureScan"("tenantId", "status");

CREATE INDEX IF NOT EXISTS "FirmCultureScan_tenantId_createdAt_idx"
  ON "FirmCultureScan"("tenantId", "createdAt" DESC);
