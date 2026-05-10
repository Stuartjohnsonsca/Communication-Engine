import { createHash } from "node:crypto";
import { superDb } from "@/lib/db";
import { adapterFor, type Tokens } from "./adapters";
import { writeAuditEvent } from "@/lib/audit";
import { synthesiseFromOutbound } from "@/lib/adherence/synthesise";
import { ensureFreshTokens } from "./oauth-refresh";

/**
 * Run an adapter ingest and persist rows as `IngestedMessage`. Returns
 * counts so the admin UI can confirm work happened.
 *
 * Idempotency: each (channelId, externalId) is unique by `hash` —
 * re-running the ingest doesn't duplicate rows. Adapter rows lacking an
 * externalId are deduped on a content-hash fallback.
 *
 * Refresh: before handing tokens to the adapter we call
 * `ensureFreshTokens` to swap an expired access_token for a fresh one
 * via the refresh_token grant. If the refresh hard-fails (refresh_token
 * revoked) the channel is flipped to REFRESH_FAILED and the ingest call
 * returns zeroes — the User must re-run OAuth.
 *
 * Side effect: every newly-inserted OUT row is handed to
 * `synthesiseFromOutbound` so the bypassed-send compliance gate fires
 * (backlog item 1). That call links the OUT to an existing SENT Draft
 * if one matches, otherwise synthesises a forensic SENT Draft + scores
 * adherence + escalates on a poor score. Failures there are logged but
 * never block the ingest count from being returned.
 */
export async function runIngest(channelId: string): Promise<{
  fetched: number;
  inserted: number;
  skipped: number;
  synthesised: number;
  matched: number;
  refreshFailed?: boolean;
}> {
  const channel = await superDb.channel.findUnique({ where: { id: channelId } });
  if (!channel) throw new Error("channel not found");

  const auths = await superDb.channelAuth.findMany({
    where: { channelId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  const auth = auths[0];

  let tokens: Tokens = {};
  let refreshFailed = false;
  if (auth) {
    const refresh = await ensureFreshTokens(auth.id);
    if (refresh.result === "failed") {
      refreshFailed = true;
    } else {
      tokens = refresh.tokens;
    }
  }

  const adapter = adapterFor(channel.kind);
  const rows = refreshFailed
    ? []
    : await adapter.ingest({
        tenantId: channel.tenantId,
        channelId,
        membershipId: auth?.membershipId ?? null,
        tokens,
        scope: auth?.scope ?? undefined,
      });

  let inserted = 0;
  let skipped = 0;
  let synthesised = 0;
  let matched = 0;
  for (const r of rows) {
    const hash = sha256(`${channelId}|${r.externalId ?? ""}|${r.body}`);
    const existing = await superDb.ingestedMessage.findFirst({
      where: { tenantId: channel.tenantId, channelId, hash },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }
    const created = await superDb.ingestedMessage.create({
      data: {
        tenantId: channel.tenantId,
        channelId,
        externalId: r.externalId,
        threadId: r.threadId,
        direction: r.direction,
        sender: r.sender,
        recipients: r.recipients,
        subject: r.subject,
        body: r.body,
        sentAt: r.sentAt,
        hash,
      },
    });
    inserted++;

    if (r.direction === "OUT") {
      try {
        const outcome = await synthesiseFromOutbound(channelId, created.id);
        if (outcome.result === "synthesised") synthesised++;
        else if (outcome.result === "matched") matched++;
      } catch (e) {
        console.error("synthesiseFromOutbound failed", { ingestedMessageId: created.id, e });
      }
    }
  }

  await writeAuditEvent({
    tenantId: channel.tenantId,
    eventType: "CHANNEL_AUTHORISED", // re-using; channel ingest events are operational not auth events
    actorMembershipId: auth?.membershipId ?? null,
    subjectType: "Channel",
    subjectId: channelId,
    payload: {
      kind: channel.kind,
      fetched: rows.length,
      inserted,
      skipped,
      synthesised,
      matched,
      op: "ingest",
      refreshFailed: refreshFailed || undefined,
    },
  });

  return {
    fetched: rows.length,
    inserted,
    skipped,
    synthesised,
    matched,
    refreshFailed: refreshFailed || undefined,
  };
}

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}
