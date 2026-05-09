import type { ChannelAdapter } from "./types";
import { mockAdapter } from "./mock";
import { m365Adapter } from "./m365";
import { googleAdapter } from "./google";
import { meta, type ChannelKind } from "../registry";

export type { ChannelAdapter, IngestRow, AdapterContext, Tokens } from "./types";

/**
 * Resolve the adapter for a given channel kind. Real adapters fall through
 * to mock at runtime if their tokens object lacks an access_token, so the
 * wiring works whether or not OAuth is configured for this deploy.
 */
export function adapterFor(kind: string): ChannelAdapter {
  const m = meta(kind as ChannelKind);
  // Even for real channel kinds, if OAuth is not configured for this
  // deployment we substitute the mock adapter outright. Keeps demo-mode
  // behaviour predictable.
  if (m.kind === "MOCK" || !m.realOAuthAvailable()) return mockAdapter;
  switch (m.kind) {
    case "M365":
    case "TEAMS":
    case "SHAREPOINT":
      return m365Adapter;
    case "GOOGLE":
      return googleAdapter;
    default:
      return mockAdapter;
  }
}
