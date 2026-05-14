import { getTenantOAuthApp } from "@/lib/channels/oauth-apps";
import { CHANNEL_KINDS, microsoftAuthority, type ChannelKind } from "@/lib/channels/registry";

/**
 * Item 109 — pre-flight validator for per-tenant ChannelOAuthApp
 * credentials. Run against the configured (tenant, kind) pair to
 * catch the common paste errors BEFORE a staff member clicks
 * Connect on /account and discovers the issue at consent-screen
 * time.
 *
 * Two layers:
 *   1. Format checks against documented provider client_id shapes
 *      (Google = `<numeric>-<alpha>.apps.googleusercontent.com`,
 *       M365/Teams/SP = UUID, Slack = `<digits>.<digits>`).
 *      Catches whitespace, wrong-app paste, accidentally-pasted
 *      client_secret in client_id field, etc.
 *   2. Live-network checks where cheap + safe:
 *      - M365/Teams/SP: GET the OIDC discovery endpoint at the
 *        per-tenant AAD authority URL. 200 means the AAD tenant
 *        exists; 400 means the tenantId is malformed or the AAD
 *        tenant doesn't exist. Doesn't validate clientId/secret
 *        (would require a token-exchange + browser handoff) but
 *        does validate the most error-prone field: the aadTenantId.
 *
 * Returns `ok: false` only on hard format errors. Live-network
 * misses surface as `warnings` so a temporary network blip doesn't
 * turn into a saved-but-flagged credential.
 *
 * Decrypts the stored secret in-memory only — `validationOutcome`
 * never carries the plaintext.
 */

export type ValidationOutcome = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export async function validateTenantOAuthApp(input: {
  tenantId: string;
  channelKind: string;
}): Promise<ValidationOutcome> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const meta = CHANNEL_KINDS[input.channelKind as ChannelKind];
  if (!meta || !meta.oauthAuthorizeUrl) {
    return {
      ok: false,
      errors: [`Channel kind "${input.channelKind}" is not OAuth-capable.`],
      warnings: [],
    };
  }

  const app = await getTenantOAuthApp(input.tenantId, input.channelKind);
  if (!app) {
    return {
      ok: false,
      errors: [
        `No OAuth app configured for ${input.channelKind}. Save the client_id + client_secret first.`,
      ],
      warnings: [],
    };
  }

  // Layer 1 — format checks per provider.
  const trimmedClientId = app.clientId.trim();
  if (trimmedClientId !== app.clientId) {
    warnings.push("client_id has leading/trailing whitespace — likely a paste error.");
  }
  if (trimmedClientId.length < 8) {
    errors.push("client_id is suspiciously short (<8 chars) — likely incomplete paste.");
  }
  if (app.clientSecret.length < 8) {
    errors.push("client_secret is suspiciously short (<8 chars) — likely incomplete paste.");
  }

  // Per-provider client_id shape checks (warnings, not errors —
  // providers can change formats and we shouldn't block).
  switch (input.channelKind) {
    case "GOOGLE":
      if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(trimmedClientId)) {
        warnings.push(
          'Google client_id usually ends in ".apps.googleusercontent.com". Yours doesn\'t — double-check you copied from the OAuth client page, not the API key page.',
        );
      }
      break;
    case "M365":
    case "TEAMS":
    case "SHAREPOINT":
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmedClientId)) {
        warnings.push(
          "Microsoft client_id should be a UUID (e.g. 11111111-2222-3333-4444-555555555555). Yours doesn't match — confirm you copied the Application (client) ID from Microsoft Entra, not the Object ID.",
        );
      }
      break;
    case "SLACK":
      if (!/^\d+\.\d+$/.test(trimmedClientId)) {
        warnings.push(
          'Slack client_id is usually two dot-separated numbers (e.g. "1234567890.0987654321"). Yours doesn\'t match — confirm you copied from the OAuth & Permissions page.',
        );
      }
      break;
  }

  // aadTenantId checks for Microsoft kinds.
  if (input.channelKind === "M365" || input.channelKind === "TEAMS" || input.channelKind === "SHAREPOINT") {
    const aadTenantId = app.additionalConfig.aadTenantId;
    if (aadTenantId) {
      const looksValid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(aadTenantId) ||
        ["common", "organizations", "consumers"].includes(aadTenantId);
      if (!looksValid) {
        errors.push(
          `aadTenantId "${aadTenantId}" is neither a UUID nor one of common/organizations/consumers. Find it in Microsoft Entra → Overview → Tenant ID.`,
        );
      }
    } else {
      warnings.push(
        "aadTenantId not set — falling back to 'common' (multi-tenant). Pin to the Client's own Entra tenant for production governance.",
      );
    }
  }

  // Layer 2 — live network check (Microsoft only, safest surface).
  if (input.channelKind === "M365" || input.channelKind === "TEAMS" || input.channelKind === "SHAREPOINT") {
    const authority = microsoftAuthority(app.additionalConfig);
    const discoveryUrl = `https://login.microsoftonline.com/${authority}/v2.0/.well-known/openid-configuration`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(discoveryUrl, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.status === 200) {
        // No-op — passing the live check adds no message; absence
        // of warnings + errors IS the green signal in the UI.
      } else if (res.status === 400) {
        errors.push(
          `Microsoft Entra rejected the authority "${authority}" (HTTP 400). The aadTenantId is malformed OR the AAD tenant doesn't exist.`,
        );
      } else {
        warnings.push(
          `Microsoft discovery endpoint returned HTTP ${res.status} for authority "${authority}" — couldn't verify tenant. Treat as soft-fail; the OAuth click-through is the real test.`,
        );
      }
    } catch (e) {
      warnings.push(
        `Couldn't reach Microsoft discovery endpoint (${e instanceof Error ? e.message : "network error"}). Treat as soft-fail; the OAuth click-through is the real test.`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
