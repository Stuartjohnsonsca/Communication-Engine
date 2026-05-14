/**
 * Channel registry. Single source of truth for the kinds of channel we can
 * authorise, the OAuth scopes we ask for, and whether the channel is
 * available in the current deployment (i.e. has the env vars wired).
 *
 * PRD §10 — Tier 1 at GA: Microsoft 365, Google Workspace, Slack.
 *
 * The adapter pattern in `./adapters/*` lets each channel kind plug in its
 * own ingestion behaviour without forcing the rest of the platform to know
 * the difference.
 */

export type ChannelKind =
  | "M365"
  | "GOOGLE"
  | "SLACK"
  | "TEAMS"
  | "SHAREPOINT"
  | "IMANAGE"
  | "ZOOM"
  | "WHATSAPP_BUSINESS"
  | "MOCK";

/**
 * Item 102 — provider-specific extra-config field declaration. The
 * /admin/channels/oauth-apps form renders one input per entry; the
 * value lands in `ChannelOAuthApp.additionalConfigJson` keyed by the
 * field's `key`. The connect + callback handlers pass the resolved
 * config map into `oauthAuthorizeUrl(config)` / `oauthTokenUrl(config)`
 * so each kind can substitute provider-specific URL parameters.
 */
export type AdditionalConfigField = {
  /** JSON key in `ChannelOAuthApp.additionalConfigJson`. */
  key: string;
  /** Form-label text. */
  label: string;
  /** Operator-facing help — where to find this value in the provider console. */
  description: string;
  /** True = save fails when missing; false = falls back to `defaultValue`. */
  required: boolean;
  /** Substituted into URLs when the operator hasn't supplied a value. */
  defaultValue?: string;
  /** Optional placeholder for the input element. */
  placeholder?: string;
};

export type ChannelKindMeta = {
  kind: ChannelKind;
  label: string;
  /** Communication categories this channel covers (used by FCG rule channelOverrides). */
  covers: string[];
  /** Tier 1 = required at GA; Tier 2 = within 6 months; Tier 3 = roadmap. */
  tier: 1 | 2 | 3 | "demo";
  scopeDefault: string[];
  prdRef: string;
  /**
   * Whether the env vars needed for the real OAuth handshake are present.
   * If not, the framework falls through to the mock adapter so the rest
   * of the platform still demonstrates end-to-end.
   */
  realOAuthAvailable: () => boolean;
  /**
   * Item 102 — both URL builders accept an optional per-tenant config
   * map (the value of `ChannelOAuthApp.additionalConfigJson` for this
   * tenant + kind). Implementations substitute provider-specific URL
   * parameters from the map; null/undefined config falls back to env
   * vars or `additionalConfigSchema[].defaultValue`.
   */
  oauthAuthorizeUrl?: (config?: Record<string, string> | null) => string;
  oauthTokenUrl?: (config?: Record<string, string> | null) => string;
  clientId?: () => string | undefined;
  /**
   * Item 102 — declares the per-tenant extras the UI prompts for.
   * Empty/missing = no extras (Google + Slack today). Set on M365
   * to capture the Microsoft Entra tenant ID. Future kinds plug in
   * by declaring their own keys here.
   */
  additionalConfigSchema?: AdditionalConfigField[];
};

const NEVER = () => false;

export const CHANNEL_KINDS: Record<ChannelKind, ChannelKindMeta> = {
  M365: {
    kind: "M365",
    label: "Microsoft 365 (Outlook + Exchange Online)",
    covers: ["EMAIL", "TEAMS", "CALENDAR", "FILES"],
    tier: 1,
    scopeDefault: [
      "offline_access",
      "User.Read",
      "Mail.Read",
      "Calendars.Read",
      "Files.Read",
      "ChannelMessage.Read.All",
    ],
    prdRef: "§10.1",
    realOAuthAvailable: () => Boolean(process.env.M365_CLIENT_ID && process.env.M365_CLIENT_SECRET),
    /**
     * Item 102 — per-tenant AAD authority. `aadTenantId` from the
     * per-tenant ChannelOAuthApp.additionalConfigJson is preferred;
     * falls back to env var (legacy / dev) and finally to "common"
     * (multi-tenant Microsoft app — accepts any AAD; broadly the
     * wrong choice for a per-Client production deploy and the UI
     * help text says so).
     */
    oauthAuthorizeUrl: (cfg) =>
      `https://login.microsoftonline.com/${m365Authority(cfg)}/oauth2/v2.0/authorize`,
    oauthTokenUrl: (cfg) =>
      `https://login.microsoftonline.com/${m365Authority(cfg)}/oauth2/v2.0/token`,
    clientId: () => process.env.M365_CLIENT_ID,
    additionalConfigSchema: [
      {
        key: "aadTenantId",
        label: "Microsoft Entra (Azure AD) Tenant ID",
        description:
          "Found in Microsoft Entra Admin Center → Overview → Tenant ID (a UUID). " +
          "Pin to the Client's own Entra tenant for single-tenant Entra app registrations. " +
          "Leave blank ONLY if the Client deliberately registered a multi-tenant Entra app " +
          "(rare for B2B compliance use); blank falls back to 'common', which accepts any " +
          "Microsoft tenant.",
        required: false,
        defaultValue: "common",
        placeholder: "e.g. 11111111-2222-3333-4444-555555555555",
      },
    ],
  },
  GOOGLE: {
    kind: "GOOGLE",
    label: "Google Workspace (Gmail)",
    covers: ["EMAIL", "CALENDAR", "FILES", "MEET"],
    tier: 1,
    scopeDefault: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
    prdRef: "§10.1",
    realOAuthAvailable: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    // Google's authorize/token URLs take no per-tenant params (the
    // Client's project is identified by client_id alone). The config
    // arg is accepted for signature parity with kinds that DO need it.
    oauthAuthorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: () => "https://oauth2.googleapis.com/token",
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    // additionalConfigSchema omitted = no extras to prompt for.
  },
  SLACK: {
    kind: "SLACK",
    label: "Slack (firm-sanctioned)",
    covers: ["SLACK"],
    tier: 1,
    scopeDefault: ["channels:history", "channels:read", "groups:history", "users:read", "team:read"],
    prdRef: "§10.1",
    realOAuthAvailable: () => Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
    oauthAuthorizeUrl: () => "https://slack.com/oauth/v2/authorize",
    oauthTokenUrl: () => "https://slack.com/api/oauth.v2.access",
    clientId: () => process.env.SLACK_CLIENT_ID,
  },
  TEAMS: {
    kind: "TEAMS",
    label: "Microsoft Teams",
    covers: ["TEAMS"],
    tier: 1,
    scopeDefault: ["ChannelMessage.Read.All", "Chat.Read"],
    prdRef: "§10.1",
    realOAuthAvailable: NEVER,
  },
  SHAREPOINT: {
    kind: "SHAREPOINT",
    label: "SharePoint",
    covers: ["FILES"],
    tier: 1,
    scopeDefault: ["Sites.Read.All", "Files.Read.All"],
    prdRef: "§10.1",
    realOAuthAvailable: NEVER,
  },
  IMANAGE: {
    kind: "IMANAGE",
    label: "iManage",
    covers: ["FILES"],
    tier: 2,
    scopeDefault: ["read"],
    prdRef: "§10.2",
    realOAuthAvailable: NEVER,
  },
  ZOOM: {
    kind: "ZOOM",
    label: "Zoom",
    covers: ["MEET"],
    tier: 2,
    scopeDefault: ["meeting:read", "recording:read"],
    prdRef: "§10.2",
    realOAuthAvailable: NEVER,
  },
  WHATSAPP_BUSINESS: {
    kind: "WHATSAPP_BUSINESS",
    label: "WhatsApp Business (sanctioned)",
    covers: ["WHATSAPP_BUSINESS"],
    tier: 2,
    scopeDefault: ["business_messaging"],
    prdRef: "§10.2",
    realOAuthAvailable: NEVER,
  },
  MOCK: {
    kind: "MOCK",
    label: "Mock channel (demo / sandbox)",
    covers: ["EMAIL", "TEAMS", "SLACK"],
    tier: "demo",
    scopeDefault: ["mock:all"],
    prdRef: "demo",
    realOAuthAvailable: () => true,
  },
};

export const ALL_KINDS: ChannelKindMeta[] = Object.values(CHANNEL_KINDS);

export function meta(kind: string): ChannelKindMeta {
  const m = CHANNEL_KINDS[kind as ChannelKind];
  if (!m) throw new Error(`Unknown channel kind: ${kind}`);
  return m;
}

/**
 * Item 102 — pick the M365 authority segment from per-tenant config or
 * fall back. Order: per-tenant `aadTenantId` → env `M365_TENANT_ID`
 * (legacy / dev) → "common" (Microsoft's multi-tenant authority).
 *
 * Validates the value is URL-safe (UUID, "common", "organizations",
 * "consumers" are the legitimate values per Microsoft's identity
 * platform docs). Anything else returns the literal authority but
 * sanitised to alphanumerics + dashes — defence against URL-injection
 * via a malformed `aadTenantId` save (the lib also validates at write
 * time via `additionalConfigSchema`, but cron + form-bypass attempts
 * would still hit this safety net).
 */
function m365Authority(cfg?: Record<string, string> | null): string {
  const raw = cfg?.aadTenantId?.trim() || process.env.M365_TENANT_ID || "common";
  // Whitelist: lowercase letters, digits, dashes only. UUIDs fit; the
  // Microsoft well-known values ("common", "organizations",
  // "consumers") fit. Anything else gets stripped to a safe subset
  // rather than passed unsanitised into a URL.
  return raw.replace(/[^a-z0-9-]/gi, "");
}
