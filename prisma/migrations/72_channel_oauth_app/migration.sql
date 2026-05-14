-- Post-PRD hardening item 101 — bring-your-own OAuth app per tenant
-- per channel kind. Each Client registers their own Google / M365 /
-- Slack OAuth application; the platform stores the credentials
-- per-tenant and resolves them at connect/callback time.
--
-- Audit enum additions for the configure + delete operations.
-- ALTER TYPE IF NOT EXISTS for fresh-deploy safety.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CHANNEL_OAUTH_APP_CONFIGURED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CHANNEL_OAUTH_APP_DELETED';

CREATE TABLE IF NOT EXISTS "ChannelOAuthApp" (
  "id"                       TEXT NOT NULL,
  "tenantId"                 TEXT NOT NULL,
  "channelKind"              TEXT NOT NULL,
  "clientId"                 TEXT NOT NULL,
  "clientSecretEncrypted"    TEXT NOT NULL,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  "updatedByMembershipId"    TEXT,
  CONSTRAINT "ChannelOAuthApp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChannelOAuthApp_tenantId_channelKind_key"
  ON "ChannelOAuthApp"("tenantId", "channelKind");

ALTER TABLE "ChannelOAuthApp"
  ADD CONSTRAINT "ChannelOAuthApp_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
