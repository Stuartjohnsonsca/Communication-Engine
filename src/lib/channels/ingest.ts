import { createHash } from "node:crypto";
import { superDb } from "@/lib/db";
import { adapterFor, type Tokens } from "./adapters";
import { writeAuditEvent } from "@/lib/audit";
import { synthesiseFromOutbound } from "@/lib/adherence/synthesise";
import { ensureFreshTokens } from "./oauth-refresh";
import { reportError } from "@/lib/observability";

/**
 * Run an adapter ingest and persist rows as `IngestedMessage`. Returns
 * counts so the admin UI can confirm work happened.
 *
 * Idempotency: each (channelId, externalId) is unique by `hash` —
 * re-running the ingest doesn't duplicate rows. Adapter rows lacking an
 * externalId are deduped on a content-hash fallback.
 *
 * **Per-Member iteration (item 104)**: ingest fans out across EVERY
 * active per-Member ChannelAuth on the channel — one adapter pass per
 * Member, each scoped to that Member's tokens. Rows that arrive in
 * multiple Members' mailboxes (e.g. an email CC'd to several staff)
 * are recorded once per mailbox because provider message IDs are
 * per-mailbox; the dedup hash includes `externalId` which differs
 * per mailbox, so each Member's view of the same thread is its own
 * IngestedMessage row. This is the right semantic for adherence
 * scoring + sentiment classification — each Member's response to a
 * shared inbound is a distinct compliance datum.
 *
 * Refresh: before handing tokens to the adapter we call
 * `ensureFreshTokens` to swap an expired access_token for a fresh one
 * via the refresh_token grant. Per-Member refresh failures are
 * recorded against THAT Member's auth only; one Member's revoked
 * refresh_token does not poison the channel for other Members.
 * `refreshFailed` in the return shape is `true` if at least one
 * Member's refresh failed.
 *
 * Side effect: every newly-inserted OUT row is handed to
 * `synthesiseFromOutbound` so the bypassed-send compliance gate fires
 * (backlog item 1). That call links the OUT to an existing SENT Draft
 * if one matches, otherwise synthesises a forensic SENT Draft + scores
 * adherence + escalates on a poor score. Failures there are logged but
 * never block the ingest count from being returned.
 *
 * Backwards-compat: if zero active auths exist on the channel (e.g.
 * MOCK channels in dev, or a channel whose tokens were all revoked),
 * a single pass runs with empty tokens. The MOCK adapter returns
 * synthetic rows in this mode; real adapters fail their API call but
 * the failure is contained — the ingest as a whole still completes
 * with zero rows.
 */
export async function runIngest(channelId: string): Promise<{
  fetched: number;
  inserted: number;
  skipped: number;
  synthesised: number;
  matched: number;
  refreshFailed?: boolean;
  /// Per-Member breakdown of the ingest pass — useful for the admin
  /// UI's per-Member ingest history. Always present (length 0 means
  /// no auths existed and the no-auth fallback didn't produce rows).
  perMember: Array<{
    membershipId: string | null;
    authId: string | null;
    fetched: number;
    inserted: number;
    skipped: number;
    refreshFailed?: boolean;
  }>;
}> {
  const channel = await superDb.channel.findUnique({ where: { id: channelId } });
  if (!channel) throw new Error("channel not found");

  const activeAuths = await superDb.channelAuth.findMany({
    where: { channelId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });

  // No-auth fallback (MOCK channels in dev). Use a synthetic
  // "passes" list with one entry that signals "no auth, empty
  // tokens" so the iteration below doesn't need a special branch.
  type Pass = {
    authId: string | null;
    membershipId: string | null;
    scope: string | null;
  };
  const passes: Pass[] =
    activeAuths.length === 0
      ? [{ authId: null, membershipId: null, scope: null }]
      : activeAuths.map((a) => ({
          authId: a.id,
          membershipId: a.membershipId,
          scope: a.scope,
        }));

  let totalFetched = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalSynthesised = 0;
  let totalMatched = 0;
  let anyRefreshFailed = false;
  const perMember: Array<{
    membershipId: string | null;
    authId: string | null;
    fetched: number;
    inserted: number;
    skipped: number;
    refreshFailed?: boolean;
  }> = [];

  const adapter = adapterFor(channel.kind);

  for (const pass of passes) {
    let tokens: Tokens = {};
    let refreshFailed = false;
    if (pass.authId) {
      const refresh = await ensureFreshTokens(pass.authId);
      if (refresh.result === "failed") {
        refreshFailed = true;
        anyRefreshFailed = true;
      } else {
        tokens = refresh.tokens;
      }
    }

    let rows: Awaited<ReturnType<typeof adapter.ingest>> = [];
    if (!refreshFailed) {
      try {
        rows = await adapter.ingest({
          tenantId: channel.tenantId,
          channelId,
          membershipId: pass.membershipId,
          tokens,
          scope: pass.scope ?? undefined,
        });
      } catch (e) {
        // Per-Member adapter failure: log and continue with the
        // next Member. One Member's transient API outage does not
        // block another Member's ingest.
        reportError(e, {
          route: "lib/channels/ingest",
          tenantId: channel.tenantId,
          extra: { channelId, membershipId: pass.membershipId, authId: pass.authId },
        }, "adapter.ingest failed for member");
        rows = [];
      }
    }

    let inserted = 0;
    let skipped = 0;
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
          if (outcome.result === "synthesised") totalSynthesised++;
          else if (outcome.result === "matched") totalMatched++;
        } catch (e) {
          reportError(e, {
            route: "lib/channels/ingest",
            tenantId: channel.tenantId,
            extra: { channelId, ingestedMessageId: created.id },
          }, "synthesiseFromOutbound failed");
        }
      }
    }

    totalFetched += rows.length;
    totalInserted += inserted;
    totalSkipped += skipped;
    perMember.push({
      membershipId: pass.membershipId,
      authId: pass.authId,
      fetched: rows.length,
      inserted,
      skipped,
      refreshFailed: refreshFailed || undefined,
    });
  }

  await writeAuditEvent({
    tenantId: channel.tenantId,
    eventType: "CHANNEL_AUTHORISED", // re-using; channel ingest events are operational not auth events
    actorMembershipId: null, // no single actor — fan-out across Members
    subjectType: "Channel",
    subjectId: channelId,
    payload: {
      kind: channel.kind,
      fetched: totalFetched,
      inserted: totalInserted,
      skipped: totalSkipped,
      synthesised: totalSynthesised,
      matched: totalMatched,
      op: "ingest",
      members: perMember.length,
      refreshFailed: anyRefreshFailed || undefined,
    },
  });

  return {
    fetched: totalFetched,
    inserted: totalInserted,
    skipped: totalSkipped,
    synthesised: totalSynthesised,
    matched: totalMatched,
    refreshFailed: anyRefreshFailed || undefined,
    perMember,
  };
}

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}
