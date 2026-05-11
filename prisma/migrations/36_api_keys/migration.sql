-- Post-PRD hardening item 16: programmatic API access via per-tenant API keys.
--
-- The natural pair to outbound webhooks (item 14). Webhooks tell an
-- integrator that something happened on Acumon's side; this gives the
-- integrator a way to call back and read follow-on data without a human
-- session cookie. Examples: a SIEM that wants to pull the audit chain for
-- archival; a BI tool that wants to read webhook delivery history; a
-- bespoke FCT-side dashboard that wants to read its tenant's adherence
-- escalations queue.
--
-- Important design choices:
--
--  1. Read-mostly surface. We deliberately do NOT expose state-changing
--     compliance operations (FCG vote, draft create, breach acknowledge,
--     DSAR fulfil, terminate tenant) over API key auth. Those operations
--     need a human session for forensic accountability — see
--     `feedback_drafts_only_post_send_check.md`: a draft is always a User
--     action, never an API caller's. Mutating endpoints that ARE
--     exposed are integrator-shaped: replay a webhook delivery,
--     create/revoke webhook subscriptions, set last-seen marker on the
--     audit cursor. Everything else is read.
--
--  2. Keys are tenant-scoped (not global) and authenticate as the
--     `createdByMembershipId` Membership's role. A FIRM_ADMIN key can do
--     FIRM_ADMIN-level reads; a FCT_MEMBER key cannot read billing. The
--     `scopes` array is a further narrowing — a FIRM_ADMIN may issue a
--     key whose scopes are `["audit:read"]` to a SIEM and that key
--     cannot read anything else, even though the underlying Membership
--     could.
--
--  3. Auto-revoke on creator-Membership going inactive. The lifecycle
--     sweep (post-PRD item 14.3 + onwards) flips Membership.status to
--     SUSPENDED/LEAVER_FROZEN/ANONYMISED on various trigger paths; any
--     ApiKey created by that Membership is auto-revoked in the same
--     sweep so a departed employee's integrator credentials stop
--     working at the same moment the rest of their access does.
--
--  4. Hash, never the secret. The plaintext key is shown exactly once on
--     creation and stored only as HMAC-SHA256 keyed off `ENCRYPTION_KEY`
--     — same defence-in-depth posture as recovery codes (`UserTotp.
--     recoveryCodesHashed`). A row-level DB leak does not directly hand
--     over working keys.
--
--  5. `prefix` is the first 12 chars of the issued string, stored in
--     plaintext + UNIQUE-indexed for lookup. The remainder (the part
--     that's actually secret) is hashed. Auth path: parse the
--     `Authorization: Bearer ack_<prefix>_<secret>` header, lookup by
--     prefix, then `timingSafeEqual` the recomputed hash against the
--     stored hash. Same shape as Stripe / GitHub PATs.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'API_KEY_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'API_KEY_REVOKED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'API_KEY_AUTH_FAILED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'API_KEY_AUTO_REVOKED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'API_KEY_USED';

CREATE TABLE IF NOT EXISTS "ApiKey" (
  "id"                    TEXT PRIMARY KEY,
  "tenantId"              TEXT NOT NULL,
  "name"                  TEXT NOT NULL,
  -- First 12 chars of the issued key, plaintext, UNIQUE — the lookup
  -- field. The remaining secret bytes are NOT stored.
  "prefix"                TEXT NOT NULL UNIQUE,
  -- HMAC-SHA256(prefix || "." || secret, ENCRYPTION_KEY). Hex-encoded.
  "hash"                  TEXT NOT NULL,
  -- Subset of canonical scope strings (see
  -- `src/lib/auth/api-keys/scopes.ts`). Wildcard `*` = every scope the
  -- creator-Membership's role grants. Stored as TEXT[] not enum for the
  -- same reason as WebhookSubscription.eventTypes — scopes evolve fast.
  "scopes"                TEXT[] NOT NULL DEFAULT '{}',
  "expiresAt"             TIMESTAMP(3),
  "lastUsedAt"            TIMESTAMP(3),
  -- Throttle to avoid one write per request: only updated when prior
  -- lastUsedAt is older than 60s. Identical pattern to Session.lastSeenAt.
  "lastUsedIp"            TEXT,
  -- Revocation bookkeeping. Row is preserved for forensic history; the
  -- lookup path treats revokedAt IS NOT NULL as "no longer valid".
  "revokedAt"             TIMESTAMP(3),
  "revokedById"           TEXT,
  "revokedReason"         TEXT,
  "createdByMembershipId" TEXT NOT NULL,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "ApiKey_tenant_fk"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "ApiKey_createdBy_fk"
    FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE CASCADE,
  CONSTRAINT "ApiKey_revokedBy_fk"
    FOREIGN KEY ("revokedById") REFERENCES "Membership"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "ApiKey_tenant_revokedAt_idx"
  ON "ApiKey" ("tenantId", "revokedAt");
CREATE INDEX IF NOT EXISTS "ApiKey_createdByMembership_idx"
  ON "ApiKey" ("createdByMembershipId");
CREATE INDEX IF NOT EXISTS "ApiKey_expiresAt_idx"
  ON "ApiKey" ("expiresAt") WHERE "expiresAt" IS NOT NULL;
