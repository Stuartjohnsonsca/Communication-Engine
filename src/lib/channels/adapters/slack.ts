import type { ChannelAdapter, IngestRow } from "./types";
import { mockAdapter } from "./mock";

/**
 * Slack adapter — pulls recent messages from the channels + DMs the
 * authorising User has access to via the Web API.
 *
 * Item 106 — first real Slack adapter. Item 101 wired Slack OAuth
 * but no adapter existed; channels routed to mockAdapter via the
 * default switch arm. This implementation:
 *   1. Lists conversations the user is a member of (`users.conversations`).
 *   2. For each conversation, fetches recent messages (`conversations.history`).
 *   3. Resolves user IDs → real names/emails (`users.info`, cached
 *      per call so a thread of 50 messages from 5 people only does
 *      5 lookups, not 50).
 *
 * **Per-Member ingest is the unit of work** (item 104) — each
 * authorising User's Slack token sees their own DMs + the channels
 * they belong to. Slack doesn't have a "sent items" folder analog;
 * direction is inferred per-message: messages whose `user` matches
 * the authorising User are OUT, everything else IN.
 *
 * **Mock fallback** (item 105) — same shape as google.ts /
 * m365.ts: `tokens.mock === true` OR absent access_token routes
 * to mockAdapter. Real-adapter paths reach the live Slack Web API.
 *
 * Scope hint: PRD §10.1 wants `channels:history`, `channels:read`,
 * `groups:history`, `users:read`, `team:read`. The real-adapter
 * paths assume those scopes have been granted; missing scopes
 * surface as 403/401 from the API and the per-pass error handler
 * in `runIngest` isolates them per-Member (item 104 invariant).
 */
export const slackAdapter: ChannelAdapter = {
  async ingest(ctx) {
    if (!ctx.tokens.access_token || ctx.tokens.mock === true) {
      return mockAdapter.ingest(ctx);
    }
    const since = ctx.since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const oldest = (since.getTime() / 1000).toFixed(6); // Slack ts is float seconds

    // Step 1 — figure out who "me" is so we can label direction.
    const me = await fetchSlack<{ user_id?: string }>(
      ctx.tokens.access_token,
      "auth.test",
    );
    const myUserId = me.user_id ?? null;

    // Step 2 — list conversations the user is a member of. Caps to
    // 25 for the same reason google + m365 cap their initial fetch:
    // bounded per-pass cost, framework pages on next tick.
    const convsResp = await fetchSlack<{
      channels?: Array<{ id: string; is_im?: boolean; name?: string }>;
    }>(ctx.tokens.access_token, "users.conversations", {
      types: "public_channel,private_channel,mpim,im",
      limit: "25",
      exclude_archived: "true",
    });
    const conversations = convsResp.channels ?? [];

    const userCache = new Map<string, { name: string; email: string | null }>();
    async function resolveUser(userId: string) {
      const cached = userCache.get(userId);
      if (cached) return cached;
      try {
        const info = await fetchSlack<{
          user?: {
            id?: string;
            real_name?: string;
            name?: string;
            profile?: { email?: string };
          };
        }>(ctx.tokens.access_token!, "users.info", { user: userId });
        const u = info.user;
        const name = u?.real_name ?? u?.name ?? userId;
        const email = u?.profile?.email ?? null;
        const v = { name, email };
        userCache.set(userId, v);
        return v;
      } catch {
        const v = { name: userId, email: null };
        userCache.set(userId, v);
        return v;
      }
    }

    const rows: IngestRow[] = [];
    for (const conv of conversations) {
      // Each conversation: pull messages newer than `oldest`. Cap
      // 25 per channel so a chatty channel doesn't dominate the
      // pass.
      const histResp = await fetchSlack<{
        messages?: Array<{
          ts?: string;
          user?: string;
          text?: string;
          thread_ts?: string;
          subtype?: string;
        }>;
      }>(ctx.tokens.access_token, "conversations.history", {
        channel: conv.id,
        oldest,
        limit: "25",
      }).catch(() => ({ messages: [] }));

      for (const msg of histResp.messages ?? []) {
        // Skip system messages (`subtype` set on join/leave/etc.).
        // Real user messages have no subtype OR subtype === "thread_broadcast".
        if (msg.subtype && msg.subtype !== "thread_broadcast") continue;
        if (!msg.ts || !msg.text || !msg.user) continue;
        const author = await resolveUser(msg.user);
        const direction: "IN" | "OUT" = msg.user === myUserId ? "OUT" : "IN";
        const sentAt = new Date(Math.floor(parseFloat(msg.ts) * 1000));
        rows.push({
          // externalId combines channel + ts so the same message in
          // two members' views (e.g. a DM both sides see) hashes
          // distinctly per-membership when ingest fans out per-Member.
          externalId: `${conv.id}:${msg.ts}`,
          threadId: msg.thread_ts ?? msg.ts,
          direction,
          sender: author.email ?? author.name,
          recipients: conv.is_im ? [] : [conv.name ?? conv.id],
          subject: conv.is_im ? "(direct message)" : `#${conv.name ?? conv.id}`,
          body: msg.text,
          sentAt,
        });
      }
    }
    return rows.slice(0, 25);
  },
};

/**
 * Slack Web API helper. POSTs form-encoded body per Slack's docs;
 * returns the parsed JSON or throws on transport / `ok: false`.
 */
type SlackEnvelope = { ok?: boolean; error?: string };

async function fetchSlack<T>(
  token: string,
  method: string,
  params: Record<string, string> = {},
): Promise<T> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Slack ${method} HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as T & SlackEnvelope;
  // Slack's "ok" envelope: even a 200 might carry `ok: false` with
  // an `error` code (e.g. `not_authed`, `missing_scope`,
  // `ratelimited`). Surface as a thrown error so the per-pass
  // catch in `runIngest` (item 104) isolates the failure to this
  // Member.
  if (data.ok === false) {
    throw new Error(`Slack ${method} returned ok=false: ${data.error ?? "unknown"}`);
  }
  return data;
}
