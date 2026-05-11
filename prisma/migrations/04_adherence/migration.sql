-- Adherence measurement (PRD §9.1) — score what was actually sent.

ALTER TABLE "Draft"
  ADD COLUMN IF NOT EXISTS "sentText"               TEXT,
  ADD COLUMN IF NOT EXISTS "sentResponseLatencyMin" INTEGER;

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ADHERENCE_SCORED';

CREATE TABLE IF NOT EXISTS "CommunicationAdherence" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "draftId"         TEXT NOT NULL,
  "membershipId"    TEXT NOT NULL,
  "fcgVersionUsed"  INTEGER NOT NULL,
  "ucgVersionUsed"  INTEGER,
  "overall"         DOUBLE PRECISION NOT NULL,
  "perDimension"    JSONB NOT NULL,
  "perRule"         JSONB NOT NULL,
  "modelRunId"      TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommunicationAdherence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommunicationAdherence_draftId_key"
  ON "CommunicationAdherence"("draftId");

CREATE INDEX IF NOT EXISTS "CommunicationAdherence_tenantId_membershipId_createdAt_idx"
  ON "CommunicationAdherence"("tenantId", "membershipId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommunicationAdherence_tenantId_fkey'
  ) THEN
    ALTER TABLE "CommunicationAdherence"
      ADD CONSTRAINT "CommunicationAdherence_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommunicationAdherence_draftId_fkey'
  ) THEN
    ALTER TABLE "CommunicationAdherence"
      ADD CONSTRAINT "CommunicationAdherence_draftId_fkey"
      FOREIGN KEY ("draftId") REFERENCES "Draft"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommunicationAdherence_membershipId_fkey'
  ) THEN
    ALTER TABLE "CommunicationAdherence"
      ADD CONSTRAINT "CommunicationAdherence_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
