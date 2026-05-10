-- Post-PRD hardening item 12: TOTP-based 2FA + per-tenant enforcement.
--
-- Sign-in is currently single-factor email-OTP via NextAuth's nodemailer
-- provider. Mail-server compromise = unbounded read of any account. SOC 2 /
-- ISO 27001 / Article 32 / every B2B procurement reviewer expects a second
-- factor on privileged user accounts. RFC 6238 TOTP is the lowest-friction
-- option — every authenticator app supports it, no external service in the
-- loop, the secret never leaves the platform once enrolled.
--
-- Design choices:
--   * `UserTotp` is global (one secret per User, not per Membership). A User
--     with memberships across multiple tenants enrolls once; per-tenant
--     enforcement is layered on top via `Tenant.requireTotp`.
--   * Secret stored as base64(AES-256-GCM(plaintext)) reusing the existing
--     ENCRYPTION_KEY (`src/lib/channels/crypto.ts`). Recovery codes are
--     SHA-256 hashed (single-use; we only ever need to verify, never to
--     display them again after enrollment).
--   * `Session.totpVerifiedAt` lifts step-up state into NextAuth's existing
--     database session row. Null = not yet verified for this session; reset
--     on every new session (sign-in). Layout-level gate redirects to
--     /login/2fa when the User has a verified UserTotp but the current
--     Session does not yet carry a totpVerifiedAt stamp.
--   * `Tenant.requireTotp` lets the Firm Administrator force enrollment for
--     every Membership in that tenant — the layout redirects un-enrolled
--     users to /account on entry.
--   * Six new audit-event types tied to the TOTP lifecycle. Audit is written
--     against the tenant the User is acting on at the time (the same chain
--     surfaces the security context for that tenant); TOTP_ENROLLED /
--     TOTP_DISABLED are written against the User's first ACTIVE Membership
--     since enrollment is per-User globally.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TOTP_ENROLLED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TOTP_DISABLED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TOTP_VERIFIED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TOTP_VERIFICATION_FAILED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TOTP_RECOVERY_CODE_USED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TENANT_TOTP_REQUIREMENT_CHANGED';

CREATE TABLE IF NOT EXISTS "UserTotp" (
  "id"                  TEXT PRIMARY KEY,
  "userId"              TEXT NOT NULL UNIQUE,
  "secretEncrypted"     TEXT NOT NULL,
  "verifiedAt"          TIMESTAMP(3),
  "disabledAt"          TIMESTAMP(3),
  "lastUsedAt"          TIMESTAMP(3),
  "recoveryCodesHashed" TEXT[] NOT NULL DEFAULT '{}',
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "UserTotp_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "UserTotp_verifiedAt_idx" ON "UserTotp" ("verifiedAt");

ALTER TABLE "Session"
  ADD COLUMN IF NOT EXISTS "totpVerifiedAt" TIMESTAMP(3);

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "requireTotp" BOOLEAN NOT NULL DEFAULT false;
