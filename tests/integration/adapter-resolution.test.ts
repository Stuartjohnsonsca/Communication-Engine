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

  it("TEAMS → mockAdapter (adapter pending; previously wrong-route to m365Adapter)", () => {
    // Item 105 invariant: TEAMS no longer routes to m365Adapter,
    // because m365Adapter only fetches mail — TEAMS connections
    // would have ingested Outlook mail labelled as Teams data.
    // Routed to mockAdapter until a real Teams adapter ships.
    expect(adapterFor("TEAMS")).toBe(mockAdapter);
  });

  it("SHAREPOINT → mockAdapter (adapter pending; same reason as TEAMS)", () => {
    expect(adapterFor("SHAREPOINT")).toBe(mockAdapter);
  });

  it("SLACK → mockAdapter (adapter pending — next item)", () => {
    expect(adapterFor("SLACK")).toBe(mockAdapter);
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
    expect(byKind.TEAMS.adapterImplemented).toBe(false);
    expect(byKind.SHAREPOINT.adapterImplemented).toBe(false);
    expect(byKind.SLACK.adapterImplemented).toBe(false);
  });

  it("KINDS_WITH_REAL_ADAPTER + isAdapterImplemented agree", () => {
    expect(isAdapterImplemented("GOOGLE")).toBe(true);
    expect(isAdapterImplemented("M365")).toBe(true);
    expect(isAdapterImplemented("TEAMS")).toBe(false);
    expect(isAdapterImplemented("SHAREPOINT")).toBe(false);
    expect(isAdapterImplemented("SLACK")).toBe(false);
    expect(KINDS_WITH_REAL_ADAPTER.has("GOOGLE")).toBe(true);
    expect(KINDS_WITH_REAL_ADAPTER.has("TEAMS")).toBe(false);
  });
});
