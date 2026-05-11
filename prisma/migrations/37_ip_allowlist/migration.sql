-- Post-PRD hardening item 17: tenant-wide IP allowlist.
--
-- Procurement reviewers commonly ask "can we restrict access to our
-- corporate IP range?" The answer needs to be yes at the platform
-- level — pushing it to a customer-owned reverse proxy isn't viable
-- because the platform terminates TLS and runs auth itself.
--
-- One TEXT[] column on Tenant: the canonical CIDR list. Empty array =
-- unrestricted (the default; preserves current behaviour for every
-- tenant that hasn't configured it). Non-empty = the caller's IP
-- must fall inside at least one of the CIDRs to authenticate.
--
-- Applies to BOTH session-based access (tenant layout enforcement)
-- and API-key access (`withApiKey` wrapper). Item 16's API keys
-- introduced a programmatic surface that's frequently consumed from
-- a static SIEM IP — the same allowlist mechanism covers both,
-- which matches how procurement reviewers think about the control.
--
-- IPv4 and IPv6 CIDRs are both supported (`192.0.2.0/24`,
-- `2001:db8::/32`, `203.0.113.5/32` for a single host). Validation
-- lives at the application layer (Tenant.allowedIpCidrs is a free
-- TEXT[] in Postgres; the page handler normalises and rejects
-- malformed entries before the row hits the DB).
--
-- Two new audit-event types:
--   TENANT_IP_ALLOWLIST_CHANGED — the Firm Administrator added /
--     removed entries. Payload contains before/after counts and
--     the new list (CIDRs are not secret).
--   IP_ALLOWLIST_DENIED — a request authenticated successfully but
--     the source IP wasn't in the allowlist. Payload contains the
--     masked IP and which auth surface triggered it (session/key).
--     Throttled to once per (tenantId, ip, hour) to keep the chain
--     bounded under a probe — same posture as RATE_LIMIT_EXCEEDED.

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "allowedIpCidrs" TEXT[] NOT NULL DEFAULT '{}';

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TENANT_IP_ALLOWLIST_CHANGED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'IP_ALLOWLIST_DENIED';
