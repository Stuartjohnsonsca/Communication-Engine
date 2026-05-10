import type { ChannelAdapter, IngestRow } from "./types";
import { mockAdapter } from "./mock";

/**
 * Google Workspace adapter — pulls recent Gmail messages via the Gmail API.
 *
 * Falls through to the mock adapter when no tokens are present.
 *
 * Backlog item 3 — body extraction:
 * Earlier versions of this adapter used `format=metadata` which only
 * returns the 200-char `snippet`. That silently broke two downstream
 * invariants:
 *   1. The bypassed-send compliance gate (item 1) does a byte-equal body
 *      match between an observed OUT message and any existing SENT Draft;
 *      a 200-char snippet would never byte-equal the full draft body, so
 *      every real-OAuth send synthesised a duplicate forensic Draft.
 *   2. The adherence judge would have been scoring a truncated send.
 *
 * We now request `format=full` and walk the MIME tree for `text/plain`,
 * falling back to `text/html` (with tags stripped) and finally to
 * `snippet`. Bodies are stored verbatim — the FCG/UCG judge handles
 * signatures and quoted replies in its prompting.
 */
export const googleAdapter: ChannelAdapter = {
  async ingest(ctx) {
    if (!ctx.tokens.access_token) {
      return mockAdapter.ingest(ctx);
    }
    const since = ctx.since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000);
    // Gmail's `q` parameter accepts `after:UNIX_SECONDS` — keeps the
    // listing tight to avoid hydrating ancient threads on first connect.
    const after = Math.floor(since.getTime() / 1000);

    const inboxIds = await listIds(ctx.tokens.access_token, ["INBOX"], 15, after);
    const sentIds = await listIds(ctx.tokens.access_token, ["SENT"], 15, after);

    const rows: IngestRow[] = [];
    for (const id of inboxIds) {
      const row = await hydrate(ctx.tokens.access_token, id, "IN");
      if (row) rows.push(row);
    }
    for (const id of sentIds) {
      const row = await hydrate(ctx.tokens.access_token, id, "OUT");
      if (row) rows.push(row);
    }
    return rows.slice(0, 25);
  },
};

async function listIds(token: string, labelIds: string[], max: number, afterUnix: number): Promise<string[]> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("maxResults", String(max));
  url.searchParams.set("q", `after:${afterUnix}`);
  for (const l of labelIds) url.searchParams.append("labelIds", l);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail list ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { messages?: { id: string }[] };
  return (data.messages ?? []).map((m) => m.id);
}

type GmailPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

type GmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] } & GmailPart;
};

async function hydrate(token: string, id: string, direction: "IN" | "OUT"): Promise<IngestRow | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Gmail get ${id}: ${res.status}`);
  }
  const data = (await res.json()) as GmailMessage;
  const headers = Object.fromEntries(
    (data.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
  );

  const body = extractBody(data.payload) ?? data.snippet ?? "";

  return {
    externalId: id,
    threadId: data.threadId,
    direction,
    sender: headers["from"],
    recipients: (headers["to"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    subject: headers["subject"],
    body,
    sentAt: data.internalDate ? new Date(Number(data.internalDate)) : undefined,
  };
}

function decodeBase64Url(s: string): string {
  // Gmail uses base64url ("-_" instead of "+/"). Pad to a multiple of 4.
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
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

function findPart(part: GmailPart | undefined, mime: string): GmailPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mime && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return undefined;
}

function extractBody(payload: GmailMessage["payload"]): string | null {
  if (!payload) return null;

  // Single-part: payload itself carries the body.
  if (payload.body?.data && (payload.mimeType === "text/plain" || payload.mimeType === "text/html")) {
    const decoded = decodeBase64Url(payload.body.data);
    return payload.mimeType === "text/plain" ? decoded : stripHtml(decoded);
  }

  // Multipart: prefer text/plain, fall back to text/html stripped.
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);

  const html = findPart(payload, "text/html");
  if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));

  return null;
}
