import type { ChannelAdapter, IngestRow } from "./types";
import { mockAdapter } from "./mock";

/**
 * Item 110 — generic IMAP adapter. Connects to the per-tenant IMAP
 * server (config from `ctx.imapConfig`) using the per-staff
 * username/password (in `ctx.tokens` with `kind: "password"`),
 * pulls recent INBOX + Sent messages, returns `IngestRow[]`.
 *
 * **Per-Member ingest is the unit of work** (item 104) — each staff
 * member has their own `ChannelAuth` with their own credentials;
 * `runIngest` fans out per-Member, this adapter handles one Member's
 * mailbox per call.
 *
 * **Failure surfacing**: if the IMAP server rejects credentials
 * (password reset upstream, account lockout), `imapflow` throws an
 * `AuthenticationFailed` error. We re-throw as a typed
 * `ImapAuthError` so `runIngest`'s per-Member catch can record
 * `lastFailureAt` on the auth + fire the mandatory
 * `channel_auth_failed` notification. Distinct from generic
 * connection errors (server unreachable, TLS handshake failure)
 * which are retryable and don't require operator intervention.
 *
 * **Mock fallback** (item 105 contract): no creds OR no IMAP config
 * → mock adapter. Keeps the same shape as Google/M365/Slack/Teams/
 * SharePoint adapters.
 *
 * **Per-pass cap of 25 IngestRow** matches the other Tier 1 adapters
 * — bounded work, framework pages on the next tick.
 *
 * **Security via TLS**: `imapSecurity: "TLS"` opens an implicit-TLS
 * connection (port 993 by convention); `STARTTLS` upgrades a plain
 * connection on port 143; `NONE` is plain (only for legacy
 * dev/lab use — production tenants should always TLS).
 */

export class ImapAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapAuthError";
  }
}

export const imapAdapter: ChannelAdapter = {
  async ingest(ctx) {
    if (
      ctx.tokens.kind !== "password" ||
      !ctx.tokens.username ||
      !ctx.tokens.password ||
      !ctx.imapConfig
    ) {
      // Item 105 fallback contract: missing credentials OR config
      // → mock data. Keeps demo / dev mode consistent.
      return mockAdapter.ingest(ctx);
    }

    const { imapHost, imapPort, imapSecurity } = ctx.imapConfig;
    const { username, password } = ctx.tokens;
    const since = ctx.since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000);

    // Lazy-import imapflow so the dep doesn't load on every Next.js
    // request — only on the IMAP-channel ingest path.
    const { ImapFlow } = await import("imapflow");

    const client = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: imapSecurity === "TLS",
      auth: { user: username, pass: password },
      // Disable imapflow's own logger — our reportError catches in
      // runIngest are the canonical path. STARTTLS is auto-detected
      // by imapflow when `secure: false` + the server advertises
      // STARTTLS capability.
      logger: false,
    });

    try {
      try {
        await client.connect();
      } catch (e) {
        // imapflow's authentication failure surfaces as `AuthenticationFailed`
        // OR with a `code: 'AuthenticationFailed'` field. We catch both.
        const msg = e instanceof Error ? e.message : String(e);
        const isAuth =
          /authent/i.test(msg) ||
          (typeof e === "object" &&
            e !== null &&
            "code" in e &&
            (e as { code?: unknown }).code === "AuthenticationFailed");
        if (isAuth) {
          throw new ImapAuthError(msg.slice(0, 500));
        }
        // Non-auth connection errors (network, TLS) re-throw as-is so
        // runIngest's per-Member catch logs them via reportError and
        // moves to the next Member.
        throw e;
      }

      const rows: IngestRow[] = [];
      // INBOX first.
      try {
        await client.mailboxOpen("INBOX");
        const inboxIdsRaw = await client.search(
          { since },
          { uid: true },
        );
        // imapflow returns `false` if the search couldn't run (rare).
        const inboxIds: number[] = Array.isArray(inboxIdsRaw) ? inboxIdsRaw : [];
        // Cap at 15 from each box so the combined cap stays at 25-ish
        // after Sent gets its share.
        const recentInbox = inboxIds.slice(-15);
        for (const uid of recentInbox) {
          const msg = await client.fetchOne(
            uid,
            { envelope: true, source: true, internalDate: true },
            { uid: true },
          );
          if (!msg) continue;
          const row = imapMessageToRow(msg, "IN");
          if (row) rows.push(row);
        }
      } catch {
        // INBOX missing/inaccessible → skip; Sent might still work.
      }
      // Sent (best-effort — not all servers expose this folder, and
      // server-side names vary: "Sent", "Sent Items", "INBOX.Sent").
      const sentCandidates = ["Sent", "Sent Items", "INBOX.Sent"];
      for (const name of sentCandidates) {
        try {
          await client.mailboxOpen(name);
          const sentIdsRaw = await client.search(
            { since },
            { uid: true },
          );
          const sentIds: number[] = Array.isArray(sentIdsRaw) ? sentIdsRaw : [];
          const recentSent = sentIds.slice(-10);
          for (const uid of recentSent) {
            const msg = await client.fetchOne(
              uid,
              { envelope: true, source: true, internalDate: true },
              { uid: true },
            );
            if (!msg) continue;
            const row = imapMessageToRow(msg, "OUT");
            if (row) rows.push(row);
          }
          break; // first one that worked is enough
        } catch {
          // try next candidate
        }
      }
      return rows.slice(0, 25);
    } finally {
      try {
        await client.logout();
      } catch {
        /* logout failures are harmless */
      }
    }
  },
};

type ImapEnvelope = {
  messageId?: string;
  subject?: string;
  from?: Array<{ name?: string; address?: string }>;
  to?: Array<{ name?: string; address?: string }>;
  date?: Date;
};

type ImapFetched = {
  uid?: number;
  envelope?: ImapEnvelope;
  source?: Buffer;
  // imapflow's FetchMessageObject types this as `string | Date` —
  // we coerce to Date in `imapMessageToRow`.
  internalDate?: Date | string;
};

function imapMessageToRow(
  msg: ImapFetched,
  direction: "IN" | "OUT",
): IngestRow | null {
  const env = msg.envelope;
  if (!env) return null;
  const externalId = env.messageId ?? (msg.uid ? `uid-${msg.uid}` : null);
  if (!externalId) return null;
  // imapflow returns the raw RFC822 source as a Buffer when `source: true`.
  // We extract a plaintext body via a minimal MIME-walk: strip headers,
  // prefer text/plain, fall back to the first 5000 chars verbatim.
  const body = extractBodyFromSource(msg.source) ?? "";
  const sentAt = env.date
    ? env.date
    : msg.internalDate
      ? msg.internalDate instanceof Date
        ? msg.internalDate
        : new Date(msg.internalDate)
      : undefined;
  return {
    externalId,
    threadId: undefined, // IMAP has no native threading; left blank
    direction,
    sender: env.from?.[0]?.address,
    recipients: (env.to ?? [])
      .map((t) => t.address ?? "")
      .filter(Boolean),
    subject: env.subject ?? undefined,
    body,
    sentAt,
  };
}

/**
 * Best-effort plaintext extraction from an RFC822 source buffer.
 *
 * Real-world IMAP messages are MIME-encoded with multiple parts (text/plain,
 * text/html, attachments). A full MIME parser would be a heavyweight dep;
 * the engine's adherence/sentiment classifiers don't need perfect HTML
 * stripping (they handle that in their prompts), so we do a pragmatic
 * walk: split on the first blank line (header/body boundary), then
 * strip CRLF and any text/html-shaped tags. Cap at 5000 chars so a
 * 20MB attachment-laden email doesn't bloat the IngestedMessage row.
 */
function extractBodyFromSource(source: Buffer | undefined): string | null {
  if (!source) return null;
  const text = source.toString("utf8");
  // Headers end at the first blank line.
  const sepIdx = text.indexOf("\r\n\r\n");
  const body = sepIdx >= 0 ? text.slice(sepIdx + 4) : text;
  // Strip simple HTML tags (bodies that are pure HTML still surface
  // readable text — full MIME parsing deferred).
  const stripped = body
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
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped.slice(0, 5000);
}
