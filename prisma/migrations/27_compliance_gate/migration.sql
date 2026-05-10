-- Backlog item 1: send-side compliance gate.
--
-- Two product invariants this migration encodes (see
-- `feedback_drafts_only_post_send_check.md` in memory):
--   1. Every observed outbound communication produces a CommunicationAdherence
--      row, even when the User bypassed the drafting UI entirely.
--   2. A poor adherence score escalates to the User AND the FCT in the same
--      lane as a sentiment escalation — recorded, not blocked.
--
-- Schema deltas:
--   * Draft gains `outboundIngestedMessageId` (back-reference to the
--     ingested OUT message that represents what was actually sent) and
--     `synthesisedFromOutboundIngest` (true for forensically reconstructed
--     SENT drafts where no drafted-then-sent path existed).
--   * CommunicationAdherence gains an escalation lifecycle
--     (escalatedAt / acknowledgedAt / acknowledgedById) mirroring
--     SentimentSignal.
--   * Three new audit event types.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'DRAFT_SYNTHESISED_FROM_OUTBOX';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ADHERENCE_ESCALATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ADHERENCE_ACKNOWLEDGED';

ALTER TABLE "Draft"
  ADD COLUMN IF NOT EXISTS "outboundIngestedMessageId"     TEXT,
  ADD COLUMN IF NOT EXISTS "synthesisedFromOutboundIngest" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Draft_outboundIngestedMessageId_fkey'
  ) THEN
    ALTER TABLE "Draft"
      ADD CONSTRAINT "Draft_outboundIngestedMessageId_fkey"
      FOREIGN KEY ("outboundIngestedMessageId")
      REFERENCES "IngestedMessage"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "Draft_outboundIngestedMessageId_key"
  ON "Draft" ("outboundIngestedMessageId")
  WHERE "outboundIngestedMessageId" IS NOT NULL;

ALTER TABLE "CommunicationAdherence"
  ADD COLUMN IF NOT EXISTS "escalatedAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "acknowledgedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "acknowledgedById" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'CommunicationAdherence_acknowledgedById_fkey'
  ) THEN
    ALTER TABLE "CommunicationAdherence"
      ADD CONSTRAINT "CommunicationAdherence_acknowledgedById_fkey"
      FOREIGN KEY ("acknowledgedById")
      REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "CommunicationAdherence_tenantId_escalatedAt_idx"
  ON "CommunicationAdherence" ("tenantId", "escalatedAt");
