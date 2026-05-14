import type { ChannelAdapter, IngestRow } from "./types";
import { mockAdapter } from "./mock";

/**
 * Microsoft 365 adapter — pulls recent inbox + sent items via the Graph API.
 *
 * If `M365_CLIENT_ID` / `M365_CLIENT_SECRET` are missing we fall through to
 * the mock adapter so a fresh deploy still has data to show. Real-mode
 * implementation is intentionally minimal: read-only against
 * `/me/mailFolders/Inbox/messages` and `/me/mailFolders/SentItems/messages`,
 * with the upstream tenant's permissions flowing through (PRD §10.4).
 */
export const m365Adapter: ChannelAdapter = {
  async ingest(ctx) {
    // Item 105 — fall back to mock when tokens are absent OR
    // explicitly mock-shaped. See google.ts for the rationale.
    if (!ctx.tokens.access_token || ctx.tokens.mock === true) {
      return mockAdapter.ingest(ctx);
    }
    const since = ctx.since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const filter = `receivedDateTime ge ${since.toISOString()}`;

    const inbox = await fetchGraph(ctx.tokens.access_token, "/me/mailFolders/Inbox/messages", filter);
    const sent = await fetchGraph(ctx.tokens.access_token, "/me/mailFolders/SentItems/messages", filter);

    const rows: IngestRow[] = [];
    for (const m of inbox) rows.push(toRow(m, "IN"));
    for (const m of sent) rows.push(toRow(m, "OUT"));
    return rows.slice(0, 25);
  },
};

type GraphMessage = {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  from?: { emailAddress?: { address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  sentDateTime?: string;
};

async function fetchGraph(token: string, path: string, filter?: string): Promise<GraphMessage[]> {
  const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
  url.searchParams.set("$top", "25");
  url.searchParams.set(
    "$select",
    "id,conversationId,subject,bodyPreview,body,from,toRecipients,receivedDateTime,sentDateTime",
  );
  if (filter) url.searchParams.set("$filter", filter);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph ${path} ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { value?: GraphMessage[] };
  return data.value ?? [];
}

function toRow(m: GraphMessage, direction: "IN" | "OUT"): IngestRow {
  return {
    externalId: m.id,
    threadId: m.conversationId,
    direction,
    sender: m.from?.emailAddress?.address,
    recipients: m.toRecipients?.map((r) => r.emailAddress?.address ?? "").filter(Boolean),
    subject: m.subject,
    body: m.body?.content ?? m.bodyPreview ?? "",
    sentAt: new Date(m.sentDateTime ?? m.receivedDateTime ?? Date.now()),
  };
}
