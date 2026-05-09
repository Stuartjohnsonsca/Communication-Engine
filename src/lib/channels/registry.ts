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
  oauthAuthorizeUrl?: () => string;
  oauthTokenUrl?: () => string;
  clientId?: () => string | undefined;
};

const NEVER = () => false;

export const CHANNEL_KINDS: Record<ChannelKind, ChannelKindMeta> = {
  M365: {
    kind: "M365",
    label: "Microsoft 365",
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
    oauthAuthorizeUrl: () =>
      `https://login.microsoftonline.com/${process.env.M365_TENANT_ID ?? "common"}/oauth2/v2.0/authorize`,
    oauthTokenUrl: () =>
      `https://login.microsoftonline.com/${process.env.M365_TENANT_ID ?? "common"}/oauth2/v2.0/token`,
    clientId: () => process.env.M365_CLIENT_ID,
  },
  GOOGLE: {
    kind: "GOOGLE",
    label: "Google Workspace",
    covers: ["EMAIL", "CALENDAR", "FILES", "MEET"],
    tier: 1,
    scopeDefault: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
    prdRef: "§10.1",
    realOAuthAvailable: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    oauthAuthorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: () => "https://oauth2.googleapis.com/token",
    clientId: () => process.env.GOOGLE_CLIENT_ID,
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
