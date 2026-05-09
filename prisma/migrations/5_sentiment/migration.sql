-- Sentiment monitoring (PRD §9.3) — extreme-positive / extreme-negative
-- boundary detector for inbound external comms. Adds escalation routing,
-- assignment to the draft owner, ack lifecycle, and the firm-handling flag.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SENTIMENT_CLASSIFIED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SENTIMENT_ESCALATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SENTIMENT_ACKNOWLEDGED';

ALTER TABLE "SentimentSignal"
  ADD COLUMN IF NOT EXISTS "isAboutFirmHandling"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "escalatedAt"             TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "acknowledgedAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "acknowledgedById"        TEXT,
  ADD COLUMN IF NOT EXISTS "assignedToMembershipId"  TEXT,
  ADD COLUMN IF NOT EXISTS "modelRunId"              TEXT;

DROP INDEX IF EXISTS "SentimentSignal_tenantId_classification_idx";

CREATE INDEX IF NOT EXISTS "SentimentSignal_tenantId_classification_createdAt_idx"
  ON "SentimentSignal"("tenantId", "classification", "createdAt");

CREATE INDEX IF NOT EXISTS "SentimentSignal_tenantId_escalatedAt_idx"
  ON "SentimentSignal"("tenantId", "escalatedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SentimentSignal_ingestedMessageId_fkey'
  ) THEN
    ALTER TABLE "SentimentSignal"
      ADD CONSTRAINT "SentimentSignal_ingestedMessageId_fkey"
      FOREIGN KEY ("ingestedMessageId") REFERENCES "IngestedMessage"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SentimentSignal_assignedToMembershipId_fkey'
  ) THEN
    ALTER TABLE "SentimentSignal"
      ADD CONSTRAINT "SentimentSignal_assignedToMembershipId_fkey"
      FOREIGN KEY ("assignedToMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SentimentSignal_acknowledgedById_fkey'
  ) THEN
    ALTER TABLE "SentimentSignal"
      ADD CONSTRAINT "SentimentSignal_acknowledgedById_fkey"
      FOREIGN KEY ("acknowledgedById") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
