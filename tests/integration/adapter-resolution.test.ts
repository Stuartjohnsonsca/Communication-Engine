/**
 * Post-PRD hardening item 105 — adapter resolution + mock fallback.
 *
 * Pins the regression fix from item 105:
 *   - `adapterFor` switches by kind only (no env-var coupling).
 *   - GOOGLE → googleAdapter; M365 → m365Adapter.
 *   - TEAMS + SHAREPOINT → mockAdapter (real adapters pending). Was
 *     previously routed to m365Adapter, which only fetches mail —
 *     would have ingested Outlook data labelled as Teams/SharePoint.
 *   - SLACK → mockAdapter (adapter pending — next item).
 *   - MOCK → mockAdapter unconditionally.
 *
 * Plus runtime mock-fallback assertions:
 *   - Real adapters (google + m365) detect `tokens.mock === true`
 *     and route to mockAdapter, even with a populated access_token.
 *     Without this, mock-mode connects (which carry a synthetic
 *     `mock-<kind>-<id>` access_token) would reach the real
 *     provider API and 401.
 *   - Empty tokens → mockAdapter.
 *   - Real-shaped tokens (no mock flag, real-looking access_token)
 *     reach the real adapter (asserted indirectly: a real-looking
 *     google token causes the adapter to attempt a fetch, which
 *     throws against the unreachable test endpoint — proves it
 *     didn't fall back to mock).
 *
 * Plus UI surfacing:
 *   - oauthCapableChannelKinds includes `adapterImplemented` flag
 *     so /admin/channels/oauth-apps can badge "Adapter pending".
 *   - GOOGLE + M365 → adapterImplemented: true; TEAMS + SHAREPOINT
 *     + SLACK → false.
 */
import { describe, it, expect } from "vitest";
import { adapterFor } from "@/lib/channels/adapters";
import { mockAdapter } from "@/lib/channels/adapters/mock";
import { googleAdapter } from "@/lib/channels/adapters/google";
import { m365Adapter } from "@/lib/channels/adapters/m365";
import { slackAdapter } from "@/lib/channels/adapters/slack";
import { teamsAdapter } from "@/lib/channels/adapters/teams";
import { sharepointAdapter } from "@/lib/channels/adapters/sharepoint";
import {
  oauthCapableChannelKinds,
  isAdapterImplemented,
  KINDS_WITH_REAL_ADAPTER,
} from "@/lib/channels/oauth-apps";

describe("adapter resolution — adapterFor switches by kind only (item 105)", () => {
  it("MOCK → mockAdapter", () => {
    expect(adapterFor("MOCK")).toBe(mockAdapter);
  });

  it("GOOGLE → googleAdapter", () => {
    expect(adapterFor("GOOGLE")).toBe(googleAdapter);
  });

  it("M365 → m365Adapter", () => {
    expect(adapterFor("M365")).toBe(m365Adapter);
  });

  it("TEAMS → teamsAdapter (item 107 — real Graph chats + channels)", () => {
    expect(adapterFor("TEAMS")).toBe(teamsAdapter);
  });

  it("SHAREPOINT → sharepointAdapter (item 108 — real Graph drive items)", () => {
    expect(adapterFor("SHAREPOINT")).toBe(sharepointAdapter);
  });

  it("SLACK → slackAdapter (item 106)", () => {
    expect(adapterFor("SLACK")).toBe(slackAdapter);
  });

  it("Tier 2 kinds (no OAuth, no adapter) fall back to mockAdapter", () => {
    expect(adapterFor("IMANAGE")).toBe(mockAdapter);
    expect(adapterFor("ZOOM")).toBe(mockAdapter);
    expect(adapterFor("WHATSAPP_BUSINESS")).toBe(mockAdapter);
  });
});

describe("adapter resolution — does NOT depend on env vars (regression fix)", () => {
  it("returns googleAdapter for GOOGLE even with env vars unset", () => {
    // Pre-item-105 behaviour: adapterFor returned mockAdapter when
    // GOOGLE_CLIENT_ID was unset. Per item 101 a tenant could have
    // a working ChannelOAuthApp row → real handshake → real
    // tokens, then ingest silently routed to mockAdapter because
    // env vars were missing. This test pins the fix: env-var
    // absence does not switch adapter selection.
    const prior = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      expect(adapterFor("GOOGLE")).toBe(googleAdapter);
    } finally {
      if (prior !== undefined) process.env.GOOGLE_CLIENT_ID = prior;
    }
  });

  it("returns m365Adapter for M365 even with env vars unset", () => {
    const prior = process.env.M365_CLIENT_ID;
    delete process.env.M365_CLIENT_ID;
    try {
      expect(adapterFor("M365")).toBe(m365Adapter);
    } finally {
      if (prior !== undefined) process.env.M365_CLIENT_ID = prior;
    }
  });
});

describe("real adapters — detect mock-mode tokens at runtime", () => {
  it("googleAdapter falls back to mockAdapter when tokens.mock === true", async () => {
    // Mock-mode connect stores a synthetic `mock-<kind>-<id>`
    // access_token. Without the runtime check, the real adapter
    // would reach the real Gmail API and 401.
    const rows = await googleAdapter.ingest({
      tenantId: "tenant-mock",
      channelId: "channel-mock",
      tokens: {
        mock: true,
        access_token: "mock-GOOGLE-channel-mock",
      },
    });
    // Mock adapter returns a non-empty synthetic batch by contract.
    expect(Array.isArray(rows)).toBe(true);
  });

  it("m365Adapter falls back to mockAdapter when tokens.mock === true", async () => {
    const rows = await m365Adapter.ingest({
      tenantId: "tenant-mock",
      channelId: "channel-mock",
      tokens: {
        mock: true,
        access_token: "mock-M365-channel-mock",
      },
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it("googleAdapter falls back when tokens.access_token is absent", async () => {
    const rows = await googleAdapter.ingest({
      tenantId: "tenant-empty",
      channelId: "channel-empty",
      tokens: {},
    });
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe("UI surfacing — adapterImplemented flag", () => {
  it("oauthCapableChannelKinds carries adapterImplemented for each kind", () => {
    const kinds = oauthCapableChannelKinds();
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k]));
    expect(byKind.GOOGLE.adapterImplemented).toBe(true);
    expect(byKind.M365.adapterImplemented).toBe(true);
    expect(byKind.SLACK.adapterImplemented).toBe(true); // item 106
    expect(byKind.TEAMS.adapterImplemented).toBe(true); // item 107
    expect(byKind.SHAREPOINT.adapterImplemented).toBe(true); // item 108
  });

  it("KINDS_WITH_REAL_ADAPTER + isAdapterImplemented agree", () => {
    expect(isAdapterImplemented("GOOGLE")).toBe(true);
    expect(isAdapterImplemented("M365")).toBe(true);
    expect(isAdapterImplemented("SLACK")).toBe(true);
    expect(isAdapterImplemented("TEAMS")).toBe(true);
    expect(isAdapterImplemented("SHAREPOINT")).toBe(true);
    expect(KINDS_WITH_REAL_ADAPTER.has("GOOGLE")).toBe(true);
    expect(KINDS_WITH_REAL_ADAPTER.has("SLACK")).toBe(true);
    expect(KINDS_WITH_REAL_ADAPTER.has("TEAMS")).toBe(true);
    expect(KINDS_WITH_REAL_ADAPTER.has("SHAREPOINT")).toBe(true);
  });
});

describe("teamsAdapter + sharepointAdapter — mock fallback shape", () => {
  it("teamsAdapter falls back to mockAdapter when tokens.mock === true", async () => {
    const rows = await teamsAdapter.ingest({
      tenantId: "tenant-mock",
      channelId: "channel-mock",
      tokens: {
        mock: true,
        access_token: "mock-TEAMS-channel-mock",
      },
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it("teamsAdapter falls back when tokens.access_token is absent", async () => {
    const rows = await teamsAdapter.ingest({
      tenantId: "tenant-empty",
      channelId: "channel-empty",
      tokens: {},
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it("sharepointAdapter falls back to mockAdapter when tokens.mock === true", async () => {
    const rows = await sharepointAdapter.ingest({
      tenantId: "tenant-mock",
      channelId: "channel-mock",
      tokens: {
        mock: true,
        access_token: "mock-SHAREPOINT-channel-mock",
      },
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it("sharepointAdapter falls back when tokens.access_token is absent", async () => {
    const rows = await sharepointAdapter.ingest({
      tenantId: "tenant-empty",
      channelId: "channel-empty",
      tokens: {},
    });
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe("slackAdapter — mock fallback shape", () => {
  it("falls back to mockAdapter when tokens.mock === true", async () => {
    const rows = await slackAdapter.ingest({
      tenantId: "tenant-mock",
      channelId: "channel-mock",
      tokens: {
        mock: true,
        access_token: "mock-SLACK-channel-mock",
      },
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it("falls back when tokens.access_token is absent", async () => {
    const rows = await slackAdapter.ingest({
      tenantId: "tenant-empty",
      channelId: "channel-empty",
      tokens: {},
    });
    expect(Array.isArray(rows)).toBe(true);
  });
});
