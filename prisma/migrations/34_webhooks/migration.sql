-- Post-PRD hardening item 14: outbound webhook delivery.
--
-- Two surfaces:
--   1. WebhookSubscription — a tenant-registered HTTPS endpoint that wants to
--      receive a signed POST whenever a chosen audit event lands on the
--      tenant's chain. The signing secret is stored encrypted at rest
--      (`secretEncrypted`, AES-256-GCM via src/lib/channels/crypto.ts) so a
--      row-level DB leak does not directly hand over the HMAC key. The
--      plaintext is shown once on creation.
--   2. WebhookDelivery — one PENDING row per (event, subscription) tuple,
--      enqueued by `enqueueWebhooks(tenantId, eventType, payload)` from
--      writeAuditEvent. The cron worker drains PENDING rows whose
--      scheduledFor has passed, retries with exponential backoff up to
--      maxAttempts (1m → 5m → 30m → 2h → 12h), and then DEAD_LETTERS.
--
-- Both are tenant-scoped + RLS-protected like other Client governance data.
-- Audit events on the lifecycle are written on the tenant chain so a
-- compliance review can see every subscription change AND every delivery
-- outcome inside the same hash chain that gates everything else.
--
-- Design choices:
--   * eventTypes is a TEXT[] not an enum[] — Postgres can't ALTER a column
--     type bound to an enum array without a rewrite, and we add audit-event
--     types every release. Dispatch checks membership with includes().
--   * `["*"]` (wildcard) means "every event type"; explicit lists only fire
--     for matching events.
--   * Auto-disable on `consecutiveFailures >= autoDisableThreshold` (default
--     25 — about a day of failures at the default backoff). A FIRM_ADMIN
--     can re-enable from the admin UI after fixing the receiver.
--   * Delivery payload is stored verbatim as the canonical JSON we sent so
--     retries are byte-stable for HMAC verification on the receiver side.
--   * `(status, scheduledFor)` index is the dispatcher's hot path so every
--     poll is O(due-rows) rather than O(table).

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'WEBHOOK_SUBSCRIPTION_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'WEBHOOK_SUBSCRIPTION_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'WEBHOOK_SUBSCRIPTION_DELETED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'WEBHOOK_SUBSCRIPTION_AUTO_DISABLED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'WEBHOOK_DELIVERED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'WEBHOOK_DELIVERY_FAILED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'WEBHOOK_DEAD_LETTERED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'WEBHOOK_REPLAYED';

CREATE TABLE IF NOT EXISTS "WebhookSubscription" (
  "id"                    TEXT PRIMARY KEY,
  "tenantId"              TEXT NOT NULL,
  "name"                  TEXT NOT NULL,
  "url"                   TEXT NOT NULL,
  "secretEncrypted"       TEXT NOT NULL,
  "eventTypes"            TEXT[] NOT NULL DEFAULT '{}',
  "enabled"               BOOLEAN NOT NULL DEFAULT TRUE,
  "autoDisableThreshold"  INTEGER NOT NULL DEFAULT 25,
  "consecutiveFailures"   INTEGER NOT NULL DEFAULT 0,
  "lastDeliveredAt"       TIMESTAMP(3),
  "lastFailureAt"         TIMESTAMP(3),
  "lastStatusCode"        INTEGER,
  "createdByMembershipId" TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "WebhookSubscription_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "WebhookSubscription_createdBy_fk"
    FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "WebhookSubscription_tenant_enabled_idx"
  ON "WebhookSubscription" ("tenantId", "enabled");
CREATE INDEX IF NOT EXISTS "WebhookSubscription_tenant_createdAt_idx"
  ON "WebhookSubscription" ("tenantId", "createdAt");

CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
  "id"               TEXT PRIMARY KEY,
  "tenantId"         TEXT NOT NULL,
  "subscriptionId"   TEXT NOT NULL,
  "eventType"        TEXT NOT NULL,
  "auditEventId"     TEXT,
  "payload"          JSONB NOT NULL,
  "attempt"          INTEGER NOT NULL DEFAULT 0,
  "maxAttempts"      INTEGER NOT NULL DEFAULT 5,
  "status"           TEXT NOT NULL DEFAULT 'PENDING',
  "scheduledFor"     TIMESTAMP(3) NOT NULL DEFAULT now(),
  "lastStatusCode"   INTEGER,
  "lastResponseBody" TEXT,
  "lastError"        TEXT,
  "completedAt"      TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "WebhookDelivery_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "WebhookDelivery_subscription_fk"
    FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "WebhookDelivery_tenant_status_scheduled_idx"
  ON "WebhookDelivery" ("tenantId", "status", "scheduledFor");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_tenant_subscription_createdAt_idx"
  ON "WebhookDelivery" ("tenantId", "subscriptionId", "createdAt");
-- Dispatcher's hot path — drain PENDING + scheduledFor < now across all
-- tenants in one query.
CREATE INDEX IF NOT EXISTS "WebhookDelivery_status_scheduled_idx"
  ON "WebhookDelivery" ("status", "scheduledFor");
