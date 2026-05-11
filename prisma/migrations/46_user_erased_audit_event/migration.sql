-- Post-PRD hardening: GDPR Art. 17 user-initiated erasure fulfillment.
-- The DSARequest lifecycle already supported kind="ERASE" but the
-- fulfilment side did not actually pseudonymise the User. New code path
-- in src/lib/dsar/erasure.ts performs the cross-tenant pseudonymisation
-- and writes this audit event to every affected tenant's chain.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'USER_ERASED';
