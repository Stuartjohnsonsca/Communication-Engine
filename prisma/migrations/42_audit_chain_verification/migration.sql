-- Post-PRD hardening item 23: background audit-chain verification +
-- tamper-detection alerting.
--
-- The per-tenant audit chain (PRD §6.2) is the load-bearing trust anchor
-- for the platform: every governance decision, every step-up gate, every
-- breach notification, every billing close commits to a hash-chained
-- AuditEvent row, and the chain integrity is what proves to a Client (and
-- their DPO) that the history they see is the history that was written.
--
-- Existing surface:
--   * `verifyAuditChain(tenantId)` in `src/lib/audit.ts` does the maths
--     (recompute every event's hash from genesis and check `prevHash`
--     linkage). Pure read.
--   * `POST /api/audit/verify` runs it ad-hoc when a FIRM_ADMIN clicks
--     "Verify chain" on /admin/audit. ONE-OFF interactive use only.
--   * Migration trigger `audit_immutable()` blocks UPDATE + DELETE at the
--     DB level. Belt; this verification is braces — it catches a
--     DB-superuser who bypassed the trigger, a backup-restore corruption,
--     or a bug that re-ordered the chain.
--
-- This item closes the gap of "nobody runs the verifier" by adding a
-- daily cron that verifies every active tenant's chain end-to-end and
-- emits `AUDIT_CHAIN_TAMPERED` audit + immediate notification on
-- failure. Successful runs update the AuditChainVerification row only
-- — same noise-management pattern as the cron heartbeat (item 22):
-- routine success is row state, not chain events.
--
-- `AuditChainVerification` is tenant-scoped + RLS-protected (the
-- verification log itself is sensitive — it tells an attacker which
-- chains have been touched and when they were last verified). Cron
-- writes via superDb but reads from /admin/audit go via tenantDb so
-- RLS double-binds.
--
-- Tamper alerts fire to BOTH the affected tenant's FIRM_ADMIN AND
-- Acumon operators — chain integrity is a contractually-relevant DPA
-- concern (the Client's controller obligations) and a platform incident
-- (Acumon's processor obligations) simultaneously.

CREATE TYPE "AuditChainVerificationStatus" AS ENUM (
  'RUNNING',
  'OK',
  'TAMPERED',
  'ERRORED'
);

CREATE TABLE "AuditChainVerification" (
  "id"           TEXT PRIMARY KEY,
  "tenantId"     TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "status"       "AuditChainVerificationStatus" NOT NULL,
  "startedAt"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "finishedAt"   TIMESTAMP(3),
  "eventCount"   INTEGER NOT NULL DEFAULT 0,
  /// Seq of the FIRST event whose hash didn't validate. Stable across
  /// reruns of the same tampering — used as part of the dedupe key so a
  /// persistent tamper alerts once, not every day. Null on OK / RUNNING.
  "failedAtSeq"  BIGINT,
  "tookMs"       INTEGER,
  "errorMessage" TEXT,
  /// Last time a tamper notification fired for this run. Subsequent runs
  /// that find the SAME failedAtSeq within the dedupe window are silent
  /// (the row's status still records the outcome). A NEW failedAtSeq
  /// (tamper extended to a different event) re-alerts immediately.
  "notifiedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX "AuditChainVerification_tenantId_startedAt_idx"
  ON "AuditChainVerification"("tenantId", "startedAt" DESC);
CREATE INDEX "AuditChainVerification_status_idx"
  ON "AuditChainVerification"("status");

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'AUDIT_CHAIN_VERIFIED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'AUDIT_CHAIN_TAMPERED';
