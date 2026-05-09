-- PRD §15.4 Terms and Conditions persistence. Per-tenant, versioned terms
-- (MSA, DPA, AUP, SLA — Sub-Processor List is global under §15.3). Each
-- (tenant, kind, version) is unique; the active version is the one with
-- status = ACTIVE. Older versions remain SUPERSEDED for audit + DSAR.
--
-- §12.5 retention: TermsRecord is excluded from the §14.4 hard-deletion
-- sweep (sibling change in `src/lib/termination/index.ts`) so the
-- "persistent until changed; survive non-renewal" PRD wording holds.
--
-- TermsRecord is added to the RLS array in `prisma/rls.sql`.

-- ─── Enums ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TermsKind') THEN
    CREATE TYPE "TermsKind" AS ENUM ('MSA', 'DPA', 'AUP', 'SLA');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TermsStatus') THEN
    CREATE TYPE "TermsStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');
  END IF;
END $$;

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TERMS_RECORDED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TERMS_ACTIVATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TERMS_SUPERSEDED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TERMS_AMENDED';

-- ─── TermsRecord ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "TermsRecord" (
  "id"                  TEXT PRIMARY KEY,
  "tenantId"            TEXT NOT NULL,
  "kind"                "TermsKind"   NOT NULL,
  "version"             INTEGER NOT NULL,
  "status"              "TermsStatus" NOT NULL DEFAULT 'DRAFT',
  "documentRef"         TEXT NOT NULL,
  "body"                TEXT NOT NULL,
  "effectiveFrom"       TIMESTAMP(3),
  "effectiveTo"         TIMESTAMP(3),
  "signedByName"        TEXT,
  "signedByRole"        TEXT,
  "signedAt"            TIMESTAMP(3),
  "countersignedByName" TEXT,
  "countersignedAt"     TIMESTAMP(3),
  "notes"               TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TermsRecord_tenantId_fkey'
  ) THEN
    ALTER TABLE "TermsRecord"
      ADD CONSTRAINT "TermsRecord_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "TermsRecord_tenantId_kind_version_key"
  ON "TermsRecord"("tenantId", "kind", "version");

CREATE INDEX IF NOT EXISTS "TermsRecord_tenantId_kind_status_idx"
  ON "TermsRecord"("tenantId", "kind", "status");

CREATE INDEX IF NOT EXISTS "TermsRecord_tenantId_status_idx"
  ON "TermsRecord"("tenantId", "status");
