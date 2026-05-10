-- Backlog item 6: notifications (weekly digest + immediate dispatch + in-app
-- unread badges).
--
-- Two surfaces:
--   1. NotificationDispatch — append-only log of every email dispatched,
--      keyed (membershipId, kind, dedupeKey) for idempotency. Weekly digest
--      uses kind="weekly_digest" + dedupeKey="<ISO week>"; immediate triggers
--      use the source row id (sentiment signal id, breach notification id,
--      adherence row id) so a flaky cron / retry never sends twice.
--   2. NotificationInbox — per-membership in-app inbox row generated for every
--      immediate-dispatch event AND for the weekly digest summary, so a User
--      who didn't get the email (no SMTP configured, mail bounced) can still
--      see what was waiting for them. Drives unread badges in the nav.
--
-- Both are tenant-scoped and RLS-protected like other Client governance
-- data. Audit events are written on the tenant chain.
--
-- Audit event additions cover the dispatch lifecycle. NOTIFICATION_DISPATCHED
-- carries `{ kind, dedupeKey, status }` so the chain shows what was sent and
-- whether it succeeded.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_DISPATCHED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_DISPATCH_FAILED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_DIGEST_RUN';

CREATE TABLE IF NOT EXISTS "NotificationDispatch" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "membershipId"  TEXT NOT NULL,
  "kind"          TEXT NOT NULL,
  "dedupeKey"     TEXT NOT NULL,
  "subject"       TEXT NOT NULL,
  "channel"       TEXT NOT NULL DEFAULT 'email',
  "status"        TEXT NOT NULL,
  "errorMessage"  TEXT,
  "payload"       JSONB NOT NULL,
  "sentAt"        TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "NotificationDispatch_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "NotificationDispatch_membership_fk"
    FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "NotificationDispatch_idem_idx"
  ON "NotificationDispatch" ("membershipId", "kind", "dedupeKey");
CREATE INDEX IF NOT EXISTS "NotificationDispatch_tenant_sentAt_idx"
  ON "NotificationDispatch" ("tenantId", "sentAt");

CREATE TABLE IF NOT EXISTS "NotificationInbox" (
  "id"             TEXT PRIMARY KEY,
  "tenantId"       TEXT NOT NULL,
  "membershipId"   TEXT NOT NULL,
  "kind"           TEXT NOT NULL,
  "dedupeKey"      TEXT NOT NULL,
  "title"          TEXT NOT NULL,
  "summary"        TEXT,
  "body"           TEXT,
  "href"           TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT now(),
  "readAt"         TIMESTAMP(3),
  "emailSentAt"    TIMESTAMP(3),
  CONSTRAINT "NotificationInbox_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "NotificationInbox_membership_fk"
    FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInbox_idem_idx"
  ON "NotificationInbox" ("membershipId", "kind", "dedupeKey");
CREATE INDEX IF NOT EXISTS "NotificationInbox_tenant_membership_unread_idx"
  ON "NotificationInbox" ("tenantId", "membershipId", "readAt");
CREATE INDEX IF NOT EXISTS "NotificationInbox_tenant_createdAt_idx"
  ON "NotificationInbox" ("tenantId", "createdAt");
