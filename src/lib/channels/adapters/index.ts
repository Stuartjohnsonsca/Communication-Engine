import type { ChannelAdapter } from "./types";
import { mockAdapter } from "./mock";
import { m365Adapter } from "./m365";
import { googleAdapter } from "./google";
import { slackAdapter } from "./slack";
import { teamsAdapter } from "./teams";
import { sharepointAdapter } from "./sharepoint";
import { meta, type ChannelKind } from "../registry";

export type { ChannelAdapter, IngestRow, AdapterContext, Tokens } from "./types";

/**
 * Resolve the adapter for a given channel kind.
 *
 * **Item 105 — fixed regression introduced by item 101.** Previously
 * this function checked `!m.realOAuthAvailable()` (env vars only)
 * and substituted `mockAdapter` outright when env vars were absent.
 * That made sense before item 101, when the only way to configure
 * OAuth was via env vars. After item 101 introduced per-tenant
 * `ChannelOAuthApp` rows, a tenant could connect successfully via
 * their own OAuth app credentials, store real tokens, then have
 * ingest silently swap in `mockAdapter` because env vars weren't
 * set — synthesising mock data under a real-looking ChannelAuth.
 *
 * The fix: route by kind only here. Real adapters detect mock-mode
 * tokens at runtime via `tokens.mock === true` (set by the connect
 * route for `mode: "mock"` connects) and fall back to
 * `mockAdapter.ingest(ctx)` themselves. Real tokens go through to
 * the real provider API. Adapter selection is no longer entangled
 * with env-var presence.
 */
export function adapterFor(kind: string): ChannelAdapter {
  const m = meta(kind as ChannelKind);
  if (m.kind === "MOCK") return mockAdapter;
  switch (m.kind) {
    case "M365":
      return m365Adapter;
    case "GOOGLE":
      return googleAdapter;
    case "SLACK":
      return slackAdapter;
    case "TEAMS":
      // Item 107 — real Teams adapter (chats + team-channel
      // messages via Graph). Replaces the item-105 stop-gap that
      // routed Teams to mockAdapter to avoid the wrong-kind
      // mail-data ingest from m365Adapter.
      return teamsAdapter;
    case "SHAREPOINT":
      // Item 108 — real SharePoint adapter (file activity from
      // OneDrive + sites the User can see). Treats file events
      // as IN-direction evidence rows; see adapter docstring for
      // why SharePoint isn't a 2-way correspondence channel.
      return sharepointAdapter;
    default:
      // Tier 2 kinds (IMANAGE / ZOOM / WHATSAPP_BUSINESS) have
      // `realOAuthAvailable: NEVER` so connect can't even start;
      // routing to mockAdapter here is just defensive.
      return mockAdapter;
  }
}
