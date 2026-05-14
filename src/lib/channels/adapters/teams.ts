import type { ChannelAdapter, IngestRow } from "./types";
import { mockAdapter } from "./mock";

/**
 * Microsoft Teams adapter — pulls recent chat + channel messages
 * via the Microsoft Graph API.
 *
 * Item 107 — first real Teams adapter. Item 103 wired Teams OAuth
 * but no real adapter existed; channels were routed (incorrectly)
 * to `m365Adapter` (mailbox-only) until item 105 redirected them
 * to mockAdapter explicitly with an "Adapter pending" badge.
 *
 * Surfaces ingested:
 *   - 1:1 + group chats: `/me/chats?$expand=lastMessagePreview` to
 *     enumerate, then `/me/chats/{chat-id}/messages` for recent
 *     content. Caps to the 25 most-recently-active chats per pass.
 *   - Joined teams + channels: `/me/joinedTeams` →
 *     `/teams/{team-id}/channels` →
 *     `/teams/{team-id}/channels/{channel-id}/messages`. Caps to 5
 *     teams × 5 channels × 5 messages per pass to bound work
 *     (channel chatter is high-volume; framework pages on next
 *     tick).
 *
 * Direction inference: `from.user.id === me.id` → OUT, else IN.
 * Resolved via `/me` at start of pass; cached per pass.
 *
 * Per-Member ingest is the unit of work (item 104) — each
 * authorising User's token sees their OWN chats + the channels
 * they're a member of. Two staff in the same team-channel will
 * each ingest a copy of every message; the dedup hash differs
 * because Teams message IDs differ per (chat, message) pair and
 * channel-message IDs include the channel id, so per-mailbox
 * uniqueness holds.
 *
 * Mock fallback (item 105) — `tokens.mock === true` OR absent
 * access_token routes to mockAdapter at runtime.
 *
 * **Body extraction**: Teams messages carry HTML in `body.content`
 * with a `body.contentType` of `html` or `text`. We strip HTML
 * the same way google.ts does (no DOM dep). System messages
 * (`messageType` !== "message") are filtered.
 */
export const teamsAdapter: ChannelAdapter = {
  async ingest(ctx) {
    if (!ctx.tokens.access_token || ctx.tokens.mock === true) {
      return mockAdapter.ingest(ctx);
    }
    const since = ctx.since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const sinceIso = since.toISOString();

    // Step 1 — who is "me"?
    const me = await fetchGraph<{ id: string }>(
      ctx.tokens.access_token,
      "/me",
    );
    const myUserId = me.id;

    const rows: IngestRow[] = [];

    // Step 2 — 1:1 + group chats. `lastUpdatedDateTime` ordering so
    // dormant chats don't dominate the page.
    const chats = await fetchGraph<{
      value?: Array<{ id?: string; chatType?: string; topic?: string }>;
    }>(ctx.tokens.access_token, "/me/chats", {
      $top: "25",
      $orderby: "lastUpdatedDateTime desc",
    }).catch(() => ({ value: [] as TeamsChat[] }));

    for (const chat of chats.value ?? []) {
      if (!chat.id) continue;
      const msgs = await fetchGraph<{ value?: TeamsMessage[] }>(
        ctx.tokens.access_token,
        `/me/chats/${encodeURIComponent(chat.id)}/messages`,
        { $top: "10" },
      ).catch(() => ({ value: [] as TeamsMessage[] }));
      for (const m of msgs.value ?? []) {
        const row = teamsMessageToRow({
          msg: m,
          conversationLabel:
            chat.topic ?? (chat.chatType === "oneOnOne" ? "(direct chat)" : "(group chat)"),
          conversationId: chat.id,
          myUserId,
          sinceIso,
        });
        if (row) rows.push(row);
      }
    }

    // Step 3 — joined teams → channels → messages. Conservatively
    // bounded so a power-user in 30 teams doesn't make this pass
    // O(n^3).
    const teams = await fetchGraph<{
      value?: Array<{ id?: string; displayName?: string }>;
    }>(ctx.tokens.access_token, "/me/joinedTeams", { $top: "5" }).catch(() => ({
      value: [] as TeamsTeam[],
    }));
    for (const team of teams.value ?? []) {
      if (!team.id) continue;
      const channels = await fetchGraph<{
        value?: Array<{ id?: string; displayName?: string }>;
      }>(ctx.tokens.access_token, `/teams/${encodeURIComponent(team.id)}/channels`, {
        $top: "5",
      }).catch(() => ({ value: [] as TeamsChannel[] }));
      for (const ch of channels.value ?? []) {
        if (!ch.id) continue;
        const msgs = await fetchGraph<{ value?: TeamsMessage[] }>(
          ctx.tokens.access_token,
          `/teams/${encodeURIComponent(team.id)}/channels/${encodeURIComponent(ch.id)}/messages`,
          { $top: "5" },
        ).catch(() => ({ value: [] as TeamsMessage[] }));
        for (const m of msgs.value ?? []) {
          const row = teamsMessageToRow({
            msg: m,
            conversationLabel: `${team.displayName ?? "team"} / ${ch.displayName ?? "channel"}`,
            conversationId: `${team.id}:${ch.id}`,
            myUserId,
            sinceIso,
          });
          if (row) rows.push(row);
        }
      }
    }

    return rows.slice(0, 25);
  },
};

type TeamsChat = { id?: string; chatType?: string; topic?: string };
type TeamsTeam = { id?: string; displayName?: string };
type TeamsChannel = { id?: string; displayName?: string };

type TeamsMessage = {
  id?: string;
  messageType?: string;
  createdDateTime?: string;
  body?: { content?: string; contentType?: string };
  from?: { user?: { id?: string; displayName?: string } } | null;
  subject?: string | null;
};

function teamsMessageToRow(opts: {
  msg: TeamsMessage;
  conversationLabel: string;
  conversationId: string;
  myUserId: string;
  sinceIso: string;
}): IngestRow | null {
  const { msg, conversationLabel, conversationId, myUserId, sinceIso } = opts;
  // System messages: messageType set to chatEvent / systemEventMessage etc.
  if (msg.messageType && msg.messageType !== "message") return null;
  if (!msg.id || !msg.body?.content) return null;
  if (msg.createdDateTime && msg.createdDateTime < sinceIso) return null;
  const fromId = msg.from?.user?.id ?? null;
  const fromName = msg.from?.user?.displayName ?? null;
  const direction: "IN" | "OUT" = fromId === myUserId ? "OUT" : "IN";
  const body =
    msg.body.contentType === "html"
      ? stripHtml(msg.body.content)
      : msg.body.content;
  return {
    externalId: `${conversationId}:${msg.id}`,
    threadId: conversationId,
    direction,
    sender: fromName ?? fromId ?? undefined,
    recipients: [conversationLabel],
    subject: msg.subject ?? conversationLabel,
    body,
    sentAt: msg.createdDateTime ? new Date(msg.createdDateTime) : undefined,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchGraph<T>(
  token: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Graph ${path} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
