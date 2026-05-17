import type { ChannelAdapter, IngestRow, DraftPushInput, DraftPushResult } from "./types";
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
    // Item 105 — fall back to mock when tokens are absent OR
    // explicitly mock-shaped (operator chose `mode: "mock"` on
    // connect). Detecting `mock: true` is necessary because the
    // mock-connect path stores a synthetic `mock-<kind>-<id>`
    // access_token, which would otherwise pass the access_token
    // check and reach the real Gmail API (which would 401).
    if (!ctx.tokens.access_token || ctx.tokens.mock === true) {
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

  /**
   * Backlog item 113 — push a draft into the User's Gmail drafts via
   * the Gmail API. The payload is a base64url-encoded RFC822 message;
   * when replying, the original `threadId` is included so Gmail
   * threads the draft under the original conversation, and the
   * `In-Reply-To` + `References` headers are set so the reply is
   * recognised as such by other mail clients.
   *
   * Requires the `https://www.googleapis.com/auth/gmail.compose` (or
   * broader) OAuth scope — `gmail.readonly` is insufficient. Existing
   * connections with read-only scope will 403; the push helper logs
   * and skips.
   *
   * Deep-link: Gmail's web UI accepts `#drafts/<draftId>` to open a
   * specific draft for editing. Account-aware (`/mail/u/0/`) handles
   * the common single-account case; multi-account users land on the
   * default profile and can switch.
   */
  async createDraft(ctx, input: DraftPushInput): Promise<DraftPushResult> {
    if (!ctx.tokens.access_token || ctx.tokens.mock === true) {
      throw new Error("google createDraft: no real OAuth token");
    }
    const token = ctx.tokens.access_token;

    // Resolve the original message's thread id + RFC822 Message-Id when
    // this is a reply. Both are needed: threadId for Gmail's threading,
    // the original `Message-ID` header for `In-Reply-To` / `References`.
    let threadId: string | undefined;
    let originalMessageIdHeader: string | undefined;
    let originalSubject: string | undefined;
    if (input.inReplyToExternalId) {
      const metaRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(input.inReplyToExternalId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (metaRes.ok) {
        const data = (await metaRes.json()) as {
          threadId?: string;
          payload?: { headers?: { name: string; value: string }[] };
        };
        threadId = data.threadId;
        for (const h of data.payload?.headers ?? []) {
          const name = h.name.toLowerCase();
          if (name === "message-id") originalMessageIdHeader = h.value;
          else if (name === "subject") originalSubject = h.value;
        }
      }
    }

    const subject =
      input.subject ||
      (originalSubject
        ? originalSubject.startsWith("Re:") ? originalSubject : `Re: ${originalSubject}`
        : "");

    const rfc822 = buildRfc822({
      from: input.fromEmail,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject,
      body: input.body,
      bodyKind: input.bodyKind,
      inReplyTo: originalMessageIdHeader,
    });
    const raw = Buffer.from(rfc822, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: { raw, ...(threadId ? { threadId } : {}) },
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gmail POST drafts ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { id?: string; message?: { id?: string } };
    const draftId = data.id;
    if (!draftId) throw new Error("Gmail drafts: no id in response");
    const webLink = `https://mail.google.com/mail/u/0/#drafts/${encodeURIComponent(draftId)}`;
    return { externalId: draftId, webLink };
  },
};

/**
 * Backlog item 113 — minimal RFC822 builder for Gmail drafts. We only
 * need the few headers Gmail honours when threading a draft and the
 * receiving client renders for the User. Avoids pulling in nodemailer
 * or mimemessage just for two-call use.
 *
 * Subject is encoded as MIME B-encoding when it contains non-ASCII
 * (UTF-8 base64) so non-Latin characters survive the SMTP path the
 * User eventually sends through. The body is sent verbatim under
 * Content-Type text/plain or text/html with charset=UTF-8.
 */
function buildRfc822(input: {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyKind: "html" | "text";
  inReplyTo?: string;
}): string {
  const headers: string[] = [];
  headers.push(`From: ${input.from}`);
  if (input.to.length) headers.push(`To: ${input.to.join(", ")}`);
  if (input.cc?.length) headers.push(`Cc: ${input.cc.join(", ")}`);
  if (input.bcc?.length) headers.push(`Bcc: ${input.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeader(input.subject)}`);
  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`);
    headers.push(`References: ${input.inReplyTo}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push(
    `Content-Type: ${input.bodyKind === "html" ? "text/html" : "text/plain"}; charset="UTF-8"`,
  );
  headers.push("Content-Transfer-Encoding: 8bit");
  return `${headers.join("\r\n")}\r\n\r\n${input.body}`;
}

function encodeHeader(s: string): string {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

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
