-- Post-PRD hardening item 18: step-up authentication for sensitive ops.
--
-- The existing TOTP gate (item 12) checks "have you verified TOTP in
-- this session at all" — once verified, the session-wide flag stays
-- set until the session ends. For high-blast-radius operations that
-- would be hard or impossible to reverse (configuring the IP
-- allowlist, flipping the tenant TOTP policy, creating an API key,
-- creating a webhook subscription, dispatching a breach notification),
-- we want an additional "verified TOTP within the last N minutes"
-- gate so a stolen open session can't perform these from across the
-- room.
--
-- Mechanism: reuse `Session.totpVerifiedAt` which the TOTP module
-- already re-stamps on every successful verify. A sensitive code
-- path calls `requireStepUp({sessionId, userId, tenant})` — if the
-- stamp is older than the freshness window, the User is redirected
-- to `/auth/2fa?stepUp=1&next=<original-url>` which forces a fresh
-- challenge even if the session-wide flag is already set.
--
-- Per-tenant `stepUpMaxAgeMinutes` overrides the platform default
-- (5 minutes). Null = inherit default. Cross-tenant Users get the
-- strictest non-null value across their active memberships — same
-- pattern as session timeouts (item 15). A slack tenant cannot
-- loosen a stricter tenant's posture.
--
-- Lockout warning: if a User has no TOTP enrolled, they cannot
-- satisfy step-up. The sensitive operation refuses with a clear
-- message ("enroll 2FA to perform this operation"). This is the
-- right tradeoff — the alternative (degrade gracefully when no
-- TOTP) defeats the security purpose.

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "stepUpMaxAgeMinutes" INTEGER;

-- One new audit-event type — written on every successful step-up
-- challenge with the original operation hint in the payload. So an
-- audit reviewer can answer "did the operator step-up before doing
-- X?" by checking for STEP_UP_VERIFIED immediately preceding X.
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'STEP_UP_VERIFIED';
