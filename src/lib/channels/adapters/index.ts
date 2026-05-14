import type { ChannelAdapter } from "./types";
import { mockAdapter } from "./mock";
import { m365Adapter } from "./m365";
import { googleAdapter } from "./google";
import { slackAdapter } from "./slack";
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
    case "SHAREPOINT":
      // Item 105 — these kinds have OAuth wiring (item 103) but
      // their REAL adapters don't exist yet. Previously they were
      // routed to `m365Adapter`, which only fetches Outlook mail —
      // a Teams or SharePoint connection would silently ingest
      // mailbox data labelled with the wrong kind. Worse than mock
      // because operators couldn't tell from row counts that
      // anything was off. Routing to `mockAdapter` here is the
      // honest interim: Teams/SharePoint connect succeeds, ingest
      // returns synthetic rows, the operator sees mock data and
      // knows real adapter work is pending. The OAuth-apps UI
      // surfaces an "adapter not yet implemented" badge so a
      // FIRM_ADMIN doesn't think they configured something
      // production-ready. Real adapters land as future items.
      return mockAdapter;
    default:
      // Tier 2 kinds (IMANAGE / ZOOM / WHATSAPP_BUSINESS) have
      // `realOAuthAvailable: NEVER` so connect can't even start;
      // routing to mockAdapter here is just defensive.
      return mockAdapter;
  }
}
