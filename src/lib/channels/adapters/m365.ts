import type { ChannelAdapter, IngestRow, DraftPushInput, DraftPushResult } from "./types";
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

  /**
   * Backlog item 113 — push a draft into the User's Outlook drafts
   * folder via the Microsoft Graph API. Two paths:
   *
   * 1. Reply draft: POST /me/messages/{id}/createReply, then PATCH the
   *    new draft's body to replace Outlook's quote-prepended template.
   *    The reply correctly threads under the original conversation.
   * 2. New draft: POST /me/messages with subject + body + recipients.
   *
   * Both return a Message resource whose `id` is stable and whose
   * `webLink` opens the draft in Outlook on the web. Requires the
   * `Mail.ReadWrite` delegated scope — existing connections with only
   * `Mail.Read` will 403 and the push helper logs + skips.
   */
  async createDraft(ctx, input: DraftPushInput): Promise<DraftPushResult> {
    if (!ctx.tokens.access_token || ctx.tokens.mock === true) {
      throw new Error("m365 createDraft: no real OAuth token");
    }
    const token = ctx.tokens.access_token;

    if (input.inReplyToExternalId) {
      // Step 1 — Graph generates the reply draft (threaded, with quoted
      // original below). We then overwrite the body with our composed
      // text. `createReply` returns the new draft Message resource.
      const replyRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(input.inReplyToExternalId)}/createReply`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        },
      );
      if (!replyRes.ok) {
        const text = await replyRes.text();
        throw new Error(`Graph createReply ${replyRes.status}: ${text.slice(0, 300)}`);
      }
      const replyDraft = (await replyRes.json()) as { id: string; webLink?: string };
      // Step 2 — overwrite the body with our composed draft.
      const patchRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(replyDraft.id)}`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            body: {
              contentType: input.bodyKind === "html" ? "HTML" : "Text",
              content: input.body,
            },
            ...(input.subject ? { subject: input.subject } : {}),
          }),
        },
      );
      if (!patchRes.ok) {
        const text = await patchRes.text();
        throw new Error(`Graph PATCH message ${patchRes.status}: ${text.slice(0, 300)}`);
      }
      return { externalId: replyDraft.id, webLink: replyDraft.webLink };
    }

    // Net-new draft.
    const newRes = await fetch(`https://graph.microsoft.com/v1.0/me/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subject: input.subject,
        body: {
          contentType: input.bodyKind === "html" ? "HTML" : "Text",
          content: input.body,
        },
        toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: (input.cc ?? []).map((address) => ({ emailAddress: { address } })),
        bccRecipients: (input.bcc ?? []).map((address) => ({ emailAddress: { address } })),
      }),
    });
    if (!newRes.ok) {
      const text = await newRes.text();
      throw new Error(`Graph POST messages ${newRes.status}: ${text.slice(0, 300)}`);
    }
    const created = (await newRes.json()) as { id: string; webLink?: string };
    return { externalId: created.id, webLink: created.webLink };
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
