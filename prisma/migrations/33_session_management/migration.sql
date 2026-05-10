-- Post-PRD hardening item 13: session management + per-session revocation.
--
-- Item 12 added a second factor but didn't give Users or Firm Administrators
-- a way to answer the *next* incident-response question: "if my credentials
-- are compromised, how do I sign out every device that's currently signed
-- in?" Cookie-only takeover, an unlocked laptop, a left-signed-in browser
-- on a shared machine — all need a single click to invalidate.
--
-- Design choices:
--   * Augment the existing NextAuth `Session` row in place rather than
--     creating a parallel table. The PrismaAdapter is wrapped (not replaced)
--     in `src/lib/auth.ts` to treat any row with `revokedAt IS NOT NULL` as
--     signed-out — keeps the row for forensic history without letting the
--     cookie continue to authenticate.
--   * Metadata (`userAgent`, `ipAddress`) is captured lazily on first
--     observation by the tenant layout. There's no clean hook in the
--     NextAuth/PrismaAdapter `createSession` path to read request headers
--     (the adapter is called from the session callback, which doesn't carry
--     the request). Touching `lastSeenAt` from the layout doubles as the
--     "online" indicator in the session list UI; we rate-limit the touch to
--     once per 60 seconds per session to keep the write rate sane.
--   * Three new audit-event types: SESSION_REVOKED (a User signs themselves
--     out of one device), SESSION_REVOKED_BY_ADMIN (FIRM_ADMIN signs another
--     User out for incident response — visible to the affected User on
--     next page load), SESSION_REVOKED_ALL (bulk revoke of every active
--     session for one User, written once with a count payload).

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SESSION_REVOKED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SESSION_REVOKED_BY_ADMIN';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'SESSION_REVOKED_ALL';

ALTER TABLE "Session"
  ADD COLUMN IF NOT EXISTS "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "lastSeenAt"    TIMESTAMP(3) NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "userAgent"     TEXT,
  ADD COLUMN IF NOT EXISTS "ipAddress"     TEXT,
  ADD COLUMN IF NOT EXISTS "revokedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revokedById"   TEXT,
  ADD COLUMN IF NOT EXISTS "revokedReason" TEXT;

CREATE INDEX IF NOT EXISTS "Session_userId_idx"    ON "Session" ("userId");
CREATE INDEX IF NOT EXISTS "Session_revokedAt_idx" ON "Session" ("revokedAt");
