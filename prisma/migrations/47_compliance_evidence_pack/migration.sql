-- Post-PRD hardening: per-tenant compliance evidence pack export
-- (procurement-visible audit-ready snapshot of security posture).
-- See src/lib/compliance/evidence-pack.ts.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'COMPLIANCE_EVIDENCE_PACK_EXPORTED';
