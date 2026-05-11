-- Post-PRD hardening: webhook subscription "Send test event" surface for
-- integrator onboarding + diagnostics. See src/lib/webhooks/test-fire.ts.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'WEBHOOK_SUBSCRIPTION_TESTED';
