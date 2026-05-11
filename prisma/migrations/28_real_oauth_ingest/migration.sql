-- Backlog item 3: real OAuth ingest end-to-end (Google Workspace).
--
-- The audit-event additions here cover the two operational events the
-- token-refresh path emits. Schema fields for token storage already
-- exist (ChannelAuth.encryptedTokens / scope / expiresAt) and the
-- channel.status string column accepts new states (REFRESH_FAILED) so
-- no column changes are needed. Membership attribution on real OAuth is
-- a runtime fix in the connect/callback routes — the
-- ChannelAuth.membershipId column was already nullable from 00_init.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CHANNEL_TOKEN_REFRESHED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CHANNEL_TOKEN_REFRESH_FAILED';
