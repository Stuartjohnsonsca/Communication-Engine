-- Post-PRD hardening item 102 — provider-specific extras on the
-- per-tenant OAuth app row. Most importantly fixes Microsoft 365
-- multi-tenant: each Client's Microsoft Entra (Azure AD) tenant ID
-- belongs in the OAuth URL and that's per-Client, not platform-wide.
--
-- Plaintext JSON column (NOT encrypted) — the values stored here are
-- public identifiers like AAD tenant IDs, never secrets. Anything
-- secret continues to live in `clientSecretEncrypted`.
--
-- Existing rows back-fill to NULL; the resolver treats NULL as
-- "no extras, fall back to provider defaults".

ALTER TABLE "ChannelOAuthApp"
  ADD COLUMN IF NOT EXISTS "additionalConfigJson" JSONB;
