import { superDb } from "@/lib/db";
import { reportError } from "@/lib/observability";
import { produceDraftFromInbound } from "./produce-from-inbound";

/**
 * Item 50 — continuous-background draft producer.
 *
 * Scans `IngestedMessage` rows for un-drafted inbound and produces a
 * draft for each via `produceDraftFromInbound`. The scan runs as a
 * fast cron (`auto-draft`) every 5 minutes — fast enough that "no
 * inbuilt latency" is honoured in practice (worst-case ~5 min between
 * mail arrival and draft availability), slow enough that batched LLM
 * spend stays predictable.
 *
 * Ownership: the draft is attributed to the Membership behind the
 * most recent ACTIVE `ChannelAuth` on the channel that ingested the
 * message. Same posture as `synthesiseFromOutbound` (item 1's
 * bypassed-send detection). Without a connected User we can't assign
 * UCG version, can't notify on escalation, so we skip rather than
 * synthesise an "anonymous" draft.
 *
 * Bounds:
 *  - `BACKLOG_WINDOW_HOURS` (24h): we only look at recently-arrived
 *    inbound. On first deploy we don't backfill the entire ingest
 *    history — that's a separate operator-driven batch and would
 *    burst LLM cost.
 *  - `MAX_PER_TENANT_PER_PASS` (25): per tenant, per cron tick.
 *    Bounds LLM spend at the platform level; a burst of 100 new
 *    inbound across one mailbox takes ~4 passes (20 minutes) to
 *    work through. Tenants who need faster turn-around tune the
 *    cron cadence on Railway.
 *  - `SCAN_PAGE_SIZE` (200): per-tenant query take. Larger than the
 *    per-pass cap on purpose so we don't miss already-drafted rows
 *    that fall outside the page on a busy tenant.
 *
 * Concurrency: the `auto-draft` cron is locked by item 47's
 * advisory-lock wrapper, so two simultaneous runs don't double up.
 * Within a run the loop is sequential.
 */

const BACKLOG_WINDOW_HOURS = 24;
const MAX_PER_TENANT_PER_PASS = 25;
const SCAN_PAGE_SIZE = 200;

export type AutoDraftSweepResult = {
  tenantsScanned: number;
  candidates: number;
  produced: number;
  skipped: number;
  errored: number;
};

export async function runAutoDraftSweep(opts?: {
  /** Override "now" — tests pin a deterministic clock. */
  now?: Date;
  /** Restrict to a single tenant — on-demand triggers + tests. */
  tenantId?: string;
}): Promise<AutoDraftSweepResult> {
  const now = opts?.now ?? new Date();
  const windowStart = new Date(now.getTime() - BACKLOG_WINDOW_HOURS * 60 * 60 * 1000);

  // Tenants in scope: ACTIVE or PROVISIONING, with at least one
  // COMMITTED FCG (drafting cannot proceed without one anyway — same
  // gate as /api/ai/draft).
  const tenants = await superDb.tenant.findMany({
    where: {
      status: { in: ["ACTIVE", "PROVISIONING"] },
      ...(opts?.tenantId ? { id: opts.tenantId } : {}),
      fcgs: { some: { status: "COMMITTED" } },
    },
    select: { id: true },
  });

  const result: AutoDraftSweepResult = {
    tenantsScanned: tenants.length,
    candidates: 0,
    produced: 0,
    skipped: 0,
    errored: 0,
  };

  for (const t of tenants) {
    const candidates = await superDb.ingestedMessage.findMany({
      where: {
        tenantId: t.id,
        direction: "IN",
        createdAt: { gte: windowStart },
        // Negative join: only rows that have NO Draft pointing at them.
        // Prisma's `none` over the relation expresses this directly and
        // translates to a `NOT EXISTS (…)` subquery.
        drafts: { none: {} },
      },
      orderBy: { createdAt: "asc" },
      take: SCAN_PAGE_SIZE,
      select: { id: true, channelId: true },
    });

    let producedForTenant = 0;
    for (const im of candidates) {
      if (producedForTenant >= MAX_PER_TENANT_PER_PASS) break;
      result.candidates += 1;

      // Resolve ownership via the most recent active ChannelAuth on the
      // channel. Without a channelId we can't attribute; skip and let
      // an operator follow up (this only happens for IM rows created
      // outside the channel-ingest path, e.g. the /api/ai/draft route
      // which always attributes via the calling Membership).
      if (!im.channelId) {
        result.skipped += 1;
        continue;
      }
      const auth = await superDb.channelAuth.findFirst({
        where: { channelId: im.channelId, revokedAt: null },
        orderBy: { createdAt: "desc" },
        select: { membershipId: true },
      });
      if (!auth?.membershipId) {
        result.skipped += 1;
        continue;
      }

      try {
        const outcome = await produceDraftFromInbound({
          tenantId: t.id,
          ingestedMessageId: im.id,
          membershipId: auth.membershipId,
        });
        if (outcome.result === "produced") {
          result.produced += 1;
          producedForTenant += 1;
        } else {
          result.skipped += 1;
        }
      } catch (err) {
        // A single LLM error / DB hiccup must not poison the whole
        // sweep. Log + count; the next cron tick retries.
        reportError(err, {
          route: "lib/drafts/auto-sweep",
          tenantId: t.id,
          extra: { ingestedMessageId: im.id, channelId: im.channelId },
        }, "auto-draft sweep produce failed");
        result.errored += 1;
      }
    }
  }

  return result;
}
