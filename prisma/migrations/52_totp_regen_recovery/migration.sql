-- Post-PRD hardening item 48: TOTP recovery code regeneration.
-- A User who has lost their printed recovery codes but still possesses
-- their authenticator device can issue a fresh set in place without
-- disabling 2FA. Single new audit event signals each regeneration; the
-- payload carries counts but never plaintext / hashes.

ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'TOTP_RECOVERY_CODES_REGENERATED';
