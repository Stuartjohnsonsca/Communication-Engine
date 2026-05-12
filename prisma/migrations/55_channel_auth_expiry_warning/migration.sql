-- Post-PRD hardening item 53: pre-emptive warning that an OAuth token
-- on an ACTIVE ChannelAuth is approaching expiry. A daily cron scans
-- for expiresAt falling inside 7-day and 1-day thresholds and
-- dispatches a `channel_auth_expiring` notification to the owning
-- Membership. Dedupes via the NotificationDispatch table; one
-- CHANNEL_AUTH_EXPIRY_WARNED audit row per (channelAuth, threshold).

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'CHANNEL_AUTH_EXPIRY_WARNED';
