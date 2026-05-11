-- Post-PRD hardening item 46: webhook signing-secret rotation with a
-- grace window. Adds a "previous secret" slot to WebhookSubscription so
-- the dispatcher can dual-sign payloads while a receiver rolls its
-- stored secret over. After secretPrevRetiresAt the dispatcher stops
-- including the previous signature.
--
-- Two columns added; new audit event records each rotation. Plaintext
-- is never stored — only the encrypted blob; the operator sees the new
-- plaintext exactly once on rotate, same posture as create.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'WEBHOOK_SUBSCRIPTION_SECRET_ROTATED';

ALTER TABLE "WebhookSubscription"
  ADD COLUMN IF NOT EXISTS "secretEncryptedPrev" TEXT,
  ADD COLUMN IF NOT EXISTS "secretPrevRetiresAt" TIMESTAMP(3);
