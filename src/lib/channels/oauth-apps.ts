import { superDb } from "@/lib/db";
import { encryptJson, decryptJson } from "@/lib/channels/crypto";
import { writeAuditEvent } from "@/lib/audit";
import { CHANNEL_KINDS, type ChannelKind } from "@/lib/channels/registry";
import { ValidationError } from "@/lib/api-errors";

/**
 * Post-PRD hardening item 101 — per-tenant bring-your-own OAuth app
 * resolver + writer.
 *
 * Multi-tenant SaaS posture (per `feedback_acumon_is_a_client.md`):
 * each Client owns their Google Cloud / Microsoft / Slack project +
 * OAuth credentials. The platform stores those credentials per-tenant
 * per-channel-kind, encrypts the secret at rest with the standard
 * `ENCRYPTION_KEY` registry, and resolves them at OAuth handshake
 * time.
 *
 * **Fallback rule** (`getTenantOAuthApp` returns null and the env-var
 * path is also unavailable):
 *   1. Per-tenant `ChannelOAuthApp` row → use its credentials.
 *   2. Else env-var defaults (`GOOGLE_CLIENT_ID`/`_SECRET` etc.) →
 *      use those (development / single-tenant deploys only).
 *   3. Else the connect route returns a clear error "Channel kind X
 *      is not configured for this tenant" — never silently falls
 *      through to the mock adapter, because a mock token in
 *      production would break ingest invisibly.
 *
 * **Channel kinds with OAuth wiring**: GOOGLE, M365, SLACK. The UI
 * filters to kinds whose registry meta has `oauthAuthorizeUrl` set.
 * Mocking + non-OAuth kinds (TEAMS, SHAREPOINT, IMANAGE, ZOOM,
 * WHATSAPP_BUSINESS) don't surface in the form.
 *
 * **Audit posture**: writes `CHANNEL_OAUTH_APP_CONFIGURED` /
 * `CHANNEL_OAUTH_APP_DELETED` with payload that includes only the
 * last-4 chars of the clientId fingerprint. The plaintext secret
 * NEVER appears in any audit row, dispatch row, or API response.
 * Last-4 of clientId is enough to confirm "yes, this is the app I
 * just configured" in a follow-up review.
 *
 * **Why not store the secret in env vars per-tenant?** Two reasons:
 *   1. Adding/rotating credentials would require a Railway redeploy
 *      with downtime; per-tenant DB row is hot-update-safe.
 *   2. A 50-Client deploy would need 50 × 3 channel-kinds = 150
 *      env vars, with no provenance trail. The DB row carries
 *      `updatedByMembershipId` + audit chain history.
 */

export type TenantOAuthAppCredentials = {
  clientId: string;
  clientSecret: string;
  /**
   * Item 102 — provider-specific extras keyed by string (`aadTenantId`
   * for M365, etc.). Always returned as `Record<string, string>` (or
   * empty object if no row was saved with extras). Callers pass this
   * straight into `oauthAuthorizeUrl(cfg)` / `oauthTokenUrl(cfg)`.
   */
  additionalConfig: Record<string, string>;
};

/**
 * Resolve the per-tenant OAuth app for a channel kind. Returns null
 * if no row exists (caller should fall back to env-var defaults or
 * surface a configuration error).
 *
 * Decrypts the secret on read — caller receives plaintext credentials
 * suitable for an immediate token-exchange POST. The plaintext should
 * NEVER be cached, logged, or returned to a client.
 */
export async function getTenantOAuthApp(
  tenantId: string,
  channelKind: string,
): Promise<TenantOAuthAppCredentials | null> {
  const row = await superDb.channelOAuthApp.findUnique({
    where: { tenantId_channelKind: { tenantId, channelKind } },
  });
  if (!row) return null;
  const secret = decryptJson<{ clientSecret: string }>(row.clientSecretEncrypted);
  return {
    clientId: row.clientId,
    clientSecret: secret.clientSecret,
    additionalConfig: normaliseAdditionalConfig(row.additionalConfigJson),
  };
}

/**
 * Coerce the JSONB column to `Record<string, string>` defensively.
 * Older rows (pre-item-102) have NULL → empty map. Non-string values
 * are dropped — callers expect string substitution into URLs.
 */
function normaliseAdditionalConfig(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * List the configured (kind, fingerprint, updatedAt) rows for a
 * tenant — for the /admin/channels/oauth-apps UI. Never decrypts the
 * secret; the page renders only the clientId fingerprint + a
 * "configured" badge.
 */
export async function listTenantOAuthApps(tenantId: string): Promise<
  Array<{
    channelKind: string;
    clientIdLast4: string;
    /// Item 102 — same plaintext map the resolver returns; UI uses
    /// it to pre-fill the additional-config inputs on edit. NEVER
    /// contains the secret.
    additionalConfig: Record<string, string>;
    updatedAt: Date;
    updatedByMembershipId: string | null;
  }>
> {
  const rows = await superDb.channelOAuthApp.findMany({
    where: { tenantId },
    orderBy: { channelKind: "asc" },
  });
  return rows.map((r) => ({
    channelKind: r.channelKind,
    clientIdLast4: lastFour(r.clientId),
    additionalConfig: normaliseAdditionalConfig(r.additionalConfigJson),
    updatedAt: r.updatedAt,
    updatedByMembershipId: r.updatedByMembershipId,
  }));
}

function lastFour(s: string): string {
  if (s.length <= 4) return "*".repeat(s.length);
  return `…${s.slice(-4)}`;
}

/**
 * Upsert a tenant's OAuth app for a channel kind. Encrypts the
 * secret at write time. Audit captures whether this was a fresh
 * config, a clientId-only change, or a secret rotation — so the
 * chain reader can correlate "the integration broke" with "we
 * rotated the secret yesterday."
 *
 * Validation:
 *   - channelKind MUST be a registry-known kind whose meta has
 *     `oauthAuthorizeUrl` set (else the OAuth handshake can't even
 *     start; storing the row would mislead).
 *   - clientId MUST be non-empty (provider IDs are typically 30+
 *     chars; we don't enforce a length but reject empty).
 *   - clientSecret MUST be non-empty. We never accept an empty
 *     secret as "preserve the existing one" — UI should pass the
 *     plaintext on every save, OR call `deleteTenantOAuthApp` to
 *     revert. This avoids a confusing "save with empty secret →
 *     silently reuse old → operator thinks they cleared it" bug.
 */
export async function upsertTenantOAuthApp(input: {
  tenantId: string;
  channelKind: string;
  clientId: string;
  clientSecret: string;
  /**
   * Item 102 — provider-specific extras keyed by string. Validated
   * against the kind's `additionalConfigSchema`: required-and-empty
   * throws; unknown keys are dropped silently (defence-in-depth).
   * Per-key length capped at 256 chars to bound the JSONB column.
   */
  additionalConfig?: Record<string, string>;
  actorMembershipId: string;
}): Promise<void> {
  const meta = CHANNEL_KINDS[input.channelKind as ChannelKind];
  if (!meta || !meta.oauthAuthorizeUrl) {
    throw new ValidationError(
      `Channel kind "${input.channelKind}" does not support OAuth.`,
      "invalid_channel_kind",
    );
  }
  const trimmedClientId = input.clientId.trim();
  const trimmedSecret = input.clientSecret.trim();
  if (trimmedClientId.length === 0) {
    throw new ValidationError("clientId is required.", "invalid_client_id");
  }
  if (trimmedSecret.length === 0) {
    throw new ValidationError(
      "clientSecret is required (use Delete to revert to platform defaults).",
      "invalid_client_secret",
    );
  }

  const cleanedConfig = validateAdditionalConfig(meta, input.additionalConfig);

  const prior = await superDb.channelOAuthApp.findUnique({
    where: {
      tenantId_channelKind: {
        tenantId: input.tenantId,
        channelKind: input.channelKind,
      },
    },
  });

  const encryptedSecret = encryptJson({ clientSecret: trimmedSecret });

  await superDb.channelOAuthApp.upsert({
    where: {
      tenantId_channelKind: {
        tenantId: input.tenantId,
        channelKind: input.channelKind,
      },
    },
    create: {
      tenantId: input.tenantId,
      channelKind: input.channelKind,
      clientId: trimmedClientId,
      clientSecretEncrypted: encryptedSecret,
      additionalConfigJson: cleanedConfig,
      updatedByMembershipId: input.actorMembershipId,
    },
    update: {
      clientId: trimmedClientId,
      clientSecretEncrypted: encryptedSecret,
      additionalConfigJson: cleanedConfig,
      updatedByMembershipId: input.actorMembershipId,
    },
  });

  // Detect whether the secret materially changed so the audit chain
  // can carry that flag. We don't compare ciphertexts (GCM nonce
  // makes them differ on every write); instead decrypt prior and
  // compare plaintexts in-memory only.
  let secretRotated = true;
  if (prior) {
    try {
      const priorSecret = decryptJson<{ clientSecret: string }>(
        prior.clientSecretEncrypted,
      );
      secretRotated = priorSecret.clientSecret !== trimmedSecret;
    } catch {
      // Decryption failed — could be a key rotation gap. Treat as
      // "rotated" defensively; the audit row's value is informational
      // not load-bearing.
      secretRotated = true;
    }
  }

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "CHANNEL_OAUTH_APP_CONFIGURED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "ChannelOAuthApp",
    subjectId: input.channelKind, // stable per-tenant subject for chain queries
    payload: {
      channelKind: input.channelKind,
      clientIdLast4: lastFour(trimmedClientId),
      secretRotated,
      isCreate: prior === null,
      // Item 102 — record which extras were configured + (for keys
      // declared as URL-substituted in the registry) a fingerprint
      // of the value. NEVER the raw value of any genuinely-secret
      // field; today the only declared extra (M365 aadTenantId) IS
      // public-by-design (it's in the OAuth URL) so we record it
      // verbatim. If a future kind declares a sensitive extra,
      // fingerprint it instead — see below.
      additionalConfigKeys: Object.keys(cleanedConfig).sort(),
      additionalConfigFingerprints: fingerprintAdditionalConfig(
        meta,
        cleanedConfig,
      ),
    },
  });
}

/**
 * Delete a tenant's OAuth app for a channel kind — reverts to env-var
 * platform defaults (or surfaces a configuration error if those
 * aren't set either). Idempotent: deleting a non-existent row is a
 * no-op (no audit, no error).
 */
export async function deleteTenantOAuthApp(input: {
  tenantId: string;
  channelKind: string;
  actorMembershipId: string;
}): Promise<{ deleted: boolean }> {
  const prior = await superDb.channelOAuthApp.findUnique({
    where: {
      tenantId_channelKind: {
        tenantId: input.tenantId,
        channelKind: input.channelKind,
      },
    },
  });
  if (!prior) return { deleted: false };

  await superDb.channelOAuthApp.delete({
    where: {
      tenantId_channelKind: {
        tenantId: input.tenantId,
        channelKind: input.channelKind,
      },
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "CHANNEL_OAUTH_APP_DELETED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "ChannelOAuthApp",
    subjectId: input.channelKind,
    payload: {
      channelKind: input.channelKind,
      hadCredentials: true,
      clientIdLast4: lastFour(prior.clientId),
    },
  });

  return { deleted: true };
}

/**
 * The set of channel kinds the /admin/channels/oauth-apps UI should
 * render rows for: every registry kind whose meta has
 * `oauthAuthorizeUrl` set. Wraps the registry walk so the UI doesn't
 * couple to internal registry shape.
 *
 * Item 102 — surfaces the kind's `additionalConfigSchema` so the
 * form can render provider-specific extra inputs (M365 → Entra
 * tenant ID, future kinds plug in here).
 */
export function oauthCapableChannelKinds(): Array<{
  kind: ChannelKind;
  label: string;
  scopeDefault: string[];
  /// Sample authorize URL with NO per-tenant config injected — for
  /// the "Authorize URL:" hint shown in the UI. The actual handshake
  /// resolves per-tenant.
  authorizeUrl: string;
  additionalConfigSchema: ReadonlyArray<{
    key: string;
    label: string;
    description: string;
    required: boolean;
    defaultValue?: string;
    placeholder?: string;
  }>;
  /// Item 105 — true when a real ingest adapter exists for this
  /// kind. False = OAuth handshake works but ingest currently
  /// returns synthetic mock data; the UI badges these as "adapter
  /// pending" so an operator doesn't think they configured a
  /// production-ready integration.
  adapterImplemented: boolean;
}> {
  return Object.values(CHANNEL_KINDS)
    .filter((m) => Boolean(m.oauthAuthorizeUrl))
    .map((m) => ({
      kind: m.kind,
      label: m.label,
      scopeDefault: m.scopeDefault,
      authorizeUrl: m.oauthAuthorizeUrl!(),
      additionalConfigSchema: m.additionalConfigSchema ?? [],
      adapterImplemented: KINDS_WITH_REAL_ADAPTER.has(m.kind),
    }));
}

/**
 * Item 105 — kinds whose real ingest adapter exists. The OAuth UI
 * still lists kinds without adapters (so per-tenant credentials can
 * be staged ahead of adapter work) but renders an "adapter pending"
 * badge so operators don't assume Configured = Production-Ready.
 *
 * Hardcoded set rather than a registry meta field because adapter
 * implementation is independent of registry shape — the source of
 * truth is `src/lib/channels/adapters/index.ts`'s `adapterFor`
 * switch, and this set must agree with it.
 */
export const KINDS_WITH_REAL_ADAPTER: ReadonlySet<ChannelKind> = new Set([
  "GOOGLE",
  "M365",
  "SLACK",
  "TEAMS",
  "SHAREPOINT",
  // Item 110 — IMAP isn't OAuth-capable so it doesn't appear on
  // /admin/channels/oauth-apps; this set is queried by the
  // adapter-pending UI badge to know whether the kind has real
  // ingest. IMAP has a real adapter (item 110), so it belongs.
  "IMAP",
]);

export function isAdapterImplemented(kind: ChannelKind): boolean {
  return KINDS_WITH_REAL_ADAPTER.has(kind);
}

/**
 * Validate + clean the user-supplied additional config against the
 * kind's declared schema.
 *   - Unknown keys → silently dropped (defence in depth: only what
 *     the registry knows about ever lands in the JSONB column).
 *   - Required keys missing → `ValidationError`.
 *   - Per-value length capped at 256 chars to bound the JSONB column;
 *     overlong values throw rather than silently truncate.
 *   - Empty/whitespace values → key omitted (so the URL builder falls
 *     back to its `defaultValue`).
 */
function validateAdditionalConfig(
  meta: {
    additionalConfigSchema?: ReadonlyArray<{
      key: string;
      label: string;
      required: boolean;
    }>;
  },
  raw: Record<string, string> | undefined,
): Record<string, string> {
  const schema = meta.additionalConfigSchema ?? [];
  const declaredKeys = new Set(schema.map((s) => s.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!declaredKeys.has(k)) continue; // drop unknown keys
    const trimmed = (v ?? "").trim();
    if (trimmed.length === 0) continue; // empty → use defaultValue
    if (trimmed.length > 256) {
      throw new ValidationError(
        `Value for "${k}" exceeds 256 chars.`,
        "invalid_additional_config",
      );
    }
    out[k] = trimmed;
  }
  for (const field of schema) {
    if (field.required && !(field.key in out)) {
      throw new ValidationError(
        `Field "${field.label}" is required.`,
        "missing_required_additional_config",
      );
    }
  }
  return out;
}

/**
 * Audit-safe fingerprint of additionalConfig values for the
 * `CHANNEL_OAUTH_APP_CONFIGURED` payload. Today every declared key
 * is public-by-design (M365 `aadTenantId` is part of the OAuth URL,
 * not a secret) so we record values verbatim. If a future kind
 * declares a sensitive extra, change the per-key handling here to
 * emit a hash/last-4 instead — the chain readers downstream are
 * tolerant of unknown keys appearing in the map.
 */
function fingerprintAdditionalConfig(
  meta: { additionalConfigSchema?: ReadonlyArray<{ key: string }> },
  cleaned: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const declared = new Set((meta.additionalConfigSchema ?? []).map((f) => f.key));
  for (const [k, v] of Object.entries(cleaned)) {
    if (!declared.has(k)) continue;
    out[k] = v; // public-by-design today; revisit if a sensitive extra is declared.
  }
  return out;
}
