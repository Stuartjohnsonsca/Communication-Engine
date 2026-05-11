-- Post-PRD hardening item 27: encryption-key rotation infrastructure.
--
-- `ApiKey.hash` is an HMAC-SHA256 keyed on ENCRYPTION_KEY. HMACs are
-- one-way so a rotated key can't re-key existing hashes — we record the
-- key version each hash was computed under so verification still works
-- against the original key. Pre-rotation rows default to "v1" matching
-- the legacy single-key posture. New keys record the active version
-- from the keys registry (see `src/lib/crypto/keys.ts`).

ALTER TABLE "ApiKey" ADD COLUMN "keyVersion" TEXT NOT NULL DEFAULT 'v1';

-- New audit event so rotation passes leave an evidence trail on the
-- Acumon operator chain.
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'ENCRYPTION_KEYS_ROTATED';
