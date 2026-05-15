-- Post-PRD hardening item 110 — password-based channel auth as an
-- alternative to OAuth, for legacy IMAP/on-prem mail servers.
--
-- Schema additions:
--   - Channel.imapConfigJson — per-tenant IMAP server config (host,
--     port, security) when kind = "IMAP".
--   - ChannelAuth.authMethod — discriminator OAUTH (default,
--     back-compat) | PASSWORD.
--   - ChannelAuth.nextReauthAt — platform-enforced re-entry deadline
--     (PASSWORD only). Indexed for the expiry-check cron's range
--     scan.
--   - ChannelAuth.lastFailureAt + lastFailureReason — populated by
--     ingest on auth failure (PASSWORD only); cleared on
--     successful re-entry.
--   - TenantCronThreshold.passwordReauthDays — per-tenant default
--     for the re-entry cadence; NULL = platform default 90.
--
-- Audit type additions: CHANNEL_PASSWORD_AUTH_REENTERED,
-- CHANNEL_PASSWORD_AUTH_FAILED, CHANNEL_PASSWORD_REAUTH_EXTENDED.
--
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS for fresh-deploy safety.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CHANNEL_PASSWORD_AUTH_REENTERED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CHANNEL_PASSWORD_AUTH_FAILED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CHANNEL_PASSWORD_REAUTH_EXTENDED';

ALTER TABLE "Channel"
  ADD COLUMN IF NOT EXISTS "imapConfigJson" JSONB;

ALTER TABLE "ChannelAuth"
  ADD COLUMN IF NOT EXISTS "authMethod"        TEXT NOT NULL DEFAULT 'OAUTH',
  ADD COLUMN IF NOT EXISTS "nextReauthAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastFailureAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastFailureReason" TEXT;

CREATE INDEX IF NOT EXISTS "ChannelAuth_nextReauthAt_idx"
  ON "ChannelAuth"("nextReauthAt");

ALTER TABLE "TenantCronThreshold"
  ADD COLUMN IF NOT EXISTS "passwordReauthDays" INTEGER;
