-- Backlog item 10: UI internationalisation.
--
-- PRD §13.5 already seeded 8 supported *content* languages in
-- `SupportedLanguage`. This migration adds the *UI* preference plumbing:
--   - Tenant.defaultLocale — the locale a Membership inherits when it has
--     no explicit preference of its own. New tenants default to "en-GB" so
--     existing behaviour is preserved.
--   - Membership.locale — per-User UI preference (nullable; null inherits
--     the tenant default). BCP-47 code; constrained at write time to a
--     row in SupportedLanguage where isInterface = true.
--
-- We deliberately store a free-form text BCP-47 code (not an FK) so a
-- Client whose Member has set "fr" continues to render in French if the
-- operator later renames the SupportedLanguage row. The validation lives
-- at the API surface (the Account form rejects unknown codes) and the
-- dictionary loader silently falls back to en-GB on any unknown code.

ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "defaultLocale" TEXT NOT NULL DEFAULT 'en-GB';
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "locale" TEXT;
