-- Post-PRD hardening item: API rate limiting + brute-force protection.
--
-- Every authenticated and public API route is currently unthrottled. The LLM
-- endpoints (drafting, judge, fcg-chat, ucg-chat) burn real model tokens per
-- call; the sign-in path is a clean brute-force surface for OTP guessing; the
-- public /status page and /api/health are scrapable. This migration adds the
-- backing table for a fixed-window rate-limit primitive (see
-- `src/lib/ratelimit/`) and an audit-event type for governance visibility.
--
-- Design choices:
--   * Global (not tenant-scoped) table — the most important limits gate
--     pre-tenant-resolution endpoints (sign-in, OAuth callback, public
--     /status) and there's no tenantId yet. Tenant-meaningful limits encode
--     tenantId into the key so per-tenant isolation is by namespace.
--   * Fixed-window counter rather than sliding window — one row per key,
--     one atomic UPSERT per check. Concurrent requests are serialised by
--     row-level lock on Postgres so two requests can't both squeak under
--     the limit during a window boundary.
--   * `lastAuditAt` throttles RATE_LIMIT_EXCEEDED writes to one per (key, hour)
--     so a runaway client can't spam the audit chain.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'RATE_LIMIT_EXCEEDED';

CREATE TABLE IF NOT EXISTS "RateLimitBucket" (
  "id"           TEXT PRIMARY KEY,
  "key"          TEXT NOT NULL,
  "windowStart"  TIMESTAMP(3) NOT NULL,
  "count"        INTEGER NOT NULL,
  "lastAuditAt"  TIMESTAMP(3),
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "RateLimitBucket_key_idx"
  ON "RateLimitBucket" ("key");
CREATE INDEX IF NOT EXISTS "RateLimitBucket_updatedAt_idx"
  ON "RateLimitBucket" ("updatedAt");
