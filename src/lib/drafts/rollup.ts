import { superDb } from "@/lib/db";

/**
 * Post-PRD hardening item 56 — draft outcome rollup.
 *
 * Item 55 answers "what is the engine costing me?" — this answers the
 * matching question "is it actually producing useful drafts?" by
 * aggregating `Draft.status` over a window per tenant. Same window
 * shape as `/admin/usage` (default 30 days, `createdAt`-bucketed).
 *
 * Source categorisation distinguishes three meaningfully-different
 * draft origins:
 *   - `ingested`         — channel-ingested inbound triggered the draft
 *                          (either via the 5-min `auto-draft` cron or
 *                          a User clicking "draft this" on an ingest
 *                          row). Has `ingestedMessageId` set,
 *                          `synthesisedFromOutboundIngest = false`.
 *   - `manual_paste`     — User pasted raw email text into /drafts/new.
 *                          No `ingestedMessageId`, no synthesis.
 *   - `bypassed_synth`   — User sent an email WITHOUT using the engine,
 *                          and the outbound was later ingested as a
 *                          best-effort synthesised Draft for adherence
 *                          scoring (`synthesisedFromOutboundIngest =
 *                          true`). Bypass rate is the central
 *                          governance signal — if 80% of sends are
 *                          bypassed, the engine is decorative.
 *
 * The auto-vs-User-from-ingest split is NOT exposed here: it requires
 * cross-referencing the audit chain (`autoProduced: true` lives in the
 * `DRAFT_PRODUCED` payload, not on `Draft`). That distinction is
 * available on /admin/channels via the auto-draft sweep run history
 * (item 52) and is intentionally not duplicated here.
 *
 * Cost is computed-on-read (item 55 pattern). No new schema, no
 * migration.
 */

export type DraftRollupWindow = 7 | 30 | 90;

/// Three buckets, exhaustive — every Draft belongs to exactly one.
export type DraftSource = "ingested" | "manual_paste" | "bypassed_synth";

export type StatusCounts = {
  PROPOSED: number;
  EDITED: number;
  ACCEPTED: number;
  SENT: number;
  DISCARDED: number;
};

export type SourceBucket = {
  produced: number;
  sent: number;
  discarded: number;
  open: number; // PROPOSED + EDITED + ACCEPTED (no terminal outcome yet)
  byStatus: StatusCounts;
};

export type DraftRollup = {
  windowDays: number;
  totals: SourceBucket;
  bySource: Record<DraftSource, SourceBucket>;
  /// Sends that bypassed the engine entirely / all observed sends.
  /// Captures the "engine is decorative" failure mode. Range [0, 1].
  /// Null when no sends have been observed.
  bypassRate: number | null;
  /// (SENT) / (produced - open). Of drafts that have reached a terminal
  /// status, the proportion sent. Excludes still-open drafts so a
  /// freshly-busy tenant doesn't appear to have a 0% send rate.
  /// Null when there are no terminal drafts yet.
  sendRate: number | null;
  /**
   * Post-PRD item 66 — FCG-window adherence at the firm level.
   *
   * The Member sees their own urgency on /drafts (item 64); this is the
   * matching firm-wide rollup: did the engine actually beat the FCG
   * response window on the drafts that got sent?
   *
   * Only drafts that HAD a `fcgWindowDeadline` count toward the rate
   * — a draft without a deadline had no promise to keep, so including
   * it would dilute the signal. `bypassed_synth` drafts are excluded
   * from this block entirely (they're post-hoc reconstructions of
   * sends that already happened outside the engine, with no engine
   * promise attached).
   *
   * `openOverdue` counts non-terminal drafts in window whose deadline
   * is already past — they haven't broken the SENT promise yet
   * (no terminal status) but the firm is currently in breach. Useful
   * to read alongside `sentAfterWindow`: are we letting drafts go cold
   * (high openOverdue) or sending them late (high sentAfterWindow)?
   */
  fcgWindow: {
    sentWithDeadline: number;
    sentWithinWindow: number;
    sentAfterWindow: number;
    openOverdue: number;
    /// sentWithinWindow / sentWithDeadline. Null when no deadlined sends.
    withinWindowRate: number | null;
  };
  regeneration: {
    /// Drafts with `parentId` set — i.e. drafts that ARE a regeneration
    /// of an earlier draft. Counts toward the "User dissatisfied with
    /// the first attempt" signal.
    childDrafts: number;
    /// Drafts that have been regenerated AT LEAST ONCE (children > 0).
    /// Distinct from `childDrafts`: a draft regenerated three times
    /// counts once as a parent here, three times as a child above.
    draftsRegeneratedAtLeastOnce: number;
    rate: number | null; // childDrafts / produced; null when produced=0
  };
  latency: {
    avgProducedToSentMin: number | null;
    avgProducedToDiscardedMin: number | null;
  };
  /// Top-N Memberships by `produced`. Membership label lookup is the
  /// caller's responsibility (matches `/admin/usage` pattern).
  byMembership: Array<{
    membershipId: string;
    produced: number;
    sent: number;
    discarded: number;
    open: number;
  }>;
};

/// Hard cap to prevent pathological row counts from melting the page.
/// A tenant sending 50k drafts in 30 days should move to server-side
/// aggregation (Prisma groupBy); current product scale is <1k/month.
const MAX_ROWS = 50_000;

function emptyStatusCounts(): StatusCounts {
  return { PROPOSED: 0, EDITED: 0, ACCEPTED: 0, SENT: 0, DISCARDED: 0 };
}

function emptyBucket(): SourceBucket {
  return {
    produced: 0,
    sent: 0,
    discarded: 0,
    open: 0,
    byStatus: emptyStatusCounts(),
  };
}

function classifySource(row: {
  ingestedMessageId: string | null;
  synthesisedFromOutboundIngest: boolean;
}): DraftSource {
  if (row.synthesisedFromOutboundIngest) return "bypassed_synth";
  if (row.ingestedMessageId) return "ingested";
  return "manual_paste";
}

export async function computeDraftRollup(input: {
  tenantId: string;
  windowDays?: DraftRollupWindow;
  topMembershipCount?: number;
}): Promise<DraftRollup> {
  const windowDays = input.windowDays ?? 30;
  const topN = input.topMembershipCount ?? 5;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await superDb.draft.findMany({
    where: { tenantId: input.tenantId, createdAt: { gte: since } },
    select: {
      id: true,
      status: true,
      membershipId: true,
      ingestedMessageId: true,
      synthesisedFromOutboundIngest: true,
      parentId: true,
      createdAt: true,
      sentMarkedAt: true,
      fcgWindowDeadline: true,
    },
    take: MAX_ROWS,
    orderBy: { createdAt: "desc" },
  });

  const totals = emptyBucket();
  const bySource: Record<DraftSource, SourceBucket> = {
    ingested: emptyBucket(),
    manual_paste: emptyBucket(),
    bypassed_synth: emptyBucket(),
  };
  const byMembership = new Map<
    string,
    { produced: number; sent: number; discarded: number; open: number }
  >();

  // For latency we sum (ms) across rows then divide at the end.
  let sentLatencyMsSum = 0;
  let sentLatencyCount = 0;
  // DISCARDED has no `discardedAt` column; best signal is
  // `updatedAt` — but Draft has no updatedAt either. Skip discard
  // latency (returned as null) rather than fake it from createdAt.

  // Regeneration: count rows with parentId (children), and collect the
  // set of parent ids referenced — those are drafts regenerated at
  // least once.
  let childDrafts = 0;
  const parentIdsReferenced = new Set<string>();

  // For the "drafts regenerated at least once" stat we also need to
  // know which of those parents fall within the window. We could
  // intersect with `rows`, but a parent might pre-date the window. The
  // count is "of children IN window, how many distinct parents are
  // there?" which is a useful approximation regardless of whether the
  // parent is itself in-window.

  let totalSent = 0;
  let totalBypassedSent = 0;

  // Item 66 — FCG-window adherence accumulators. We snapshot `now`
  // once per call so "open + overdue" is evaluated against a single
  // wall-clock and the test can pin it via the global Date.
  const now = new Date();
  let fcgSentWithDeadline = 0;
  let fcgSentWithinWindow = 0;
  let fcgSentAfterWindow = 0;
  let fcgOpenOverdue = 0;

  for (const r of rows) {
    const source = classifySource(r);
    const bucket = bySource[source];

    function bump(b: SourceBucket) {
      b.produced += 1;
      b.byStatus[r.status] += 1;
      if (r.status === "SENT") b.sent += 1;
      else if (r.status === "DISCARDED") b.discarded += 1;
      else b.open += 1; // PROPOSED, EDITED, ACCEPTED
    }
    bump(totals);
    bump(bucket);

    if (r.status === "SENT") {
      totalSent += 1;
      if (source === "bypassed_synth") totalBypassedSent += 1;
      if (r.sentMarkedAt && r.createdAt) {
        const ms = r.sentMarkedAt.getTime() - r.createdAt.getTime();
        if (ms >= 0) {
          sentLatencyMsSum += ms;
          sentLatencyCount += 1;
        }
      }
    }

    // Item 66 — FCG-window adherence. Bypassed-synth drafts are
    // excluded: they're post-hoc reconstructions of sends that already
    // happened outside the engine, so the "did we beat the deadline"
    // promise never applied. Drafts with no deadline are excluded for
    // the same reason: no promise, nothing to measure.
    if (source !== "bypassed_synth" && r.fcgWindowDeadline) {
      const deadline = r.fcgWindowDeadline.getTime();
      if (r.status === "SENT" && r.sentMarkedAt) {
        fcgSentWithDeadline += 1;
        if (r.sentMarkedAt.getTime() <= deadline) fcgSentWithinWindow += 1;
        else fcgSentAfterWindow += 1;
      } else if (r.status !== "SENT" && r.status !== "DISCARDED") {
        // Non-terminal in-flight breach: deadline is already past but the
        // draft hasn't been sent yet. Discards excluded (operator decided
        // it was out of scope; not a broken promise).
        if (deadline < now.getTime()) fcgOpenOverdue += 1;
      }
    }

    if (r.parentId) {
      childDrafts += 1;
      parentIdsReferenced.add(r.parentId);
    }

    if (r.membershipId) {
      const existing =
        byMembership.get(r.membershipId) ?? {
          produced: 0,
          sent: 0,
          discarded: 0,
          open: 0,
        };
      existing.produced += 1;
      if (r.status === "SENT") existing.sent += 1;
      else if (r.status === "DISCARDED") existing.discarded += 1;
      else existing.open += 1;
      byMembership.set(r.membershipId, existing);
    }
  }

  const sentRate =
    totals.produced - totals.open > 0
      ? totals.sent / (totals.produced - totals.open)
      : null;

  const bypassRate = totalSent > 0 ? totalBypassedSent / totalSent : null;

  const regenRate =
    totals.produced > 0 ? childDrafts / totals.produced : null;

  const avgSentLatencyMin =
    sentLatencyCount > 0
      ? Math.round(sentLatencyMsSum / sentLatencyCount / 60_000)
      : null;

  const topByMembership = Array.from(byMembership.entries())
    .sort((a, b) => b[1].produced - a[1].produced)
    .slice(0, topN)
    .map(([membershipId, v]) => ({ membershipId, ...v }));

  const withinWindowRate =
    fcgSentWithDeadline > 0 ? fcgSentWithinWindow / fcgSentWithDeadline : null;

  return {
    windowDays,
    totals,
    bySource,
    bypassRate,
    sendRate: sentRate,
    fcgWindow: {
      sentWithDeadline: fcgSentWithDeadline,
      sentWithinWindow: fcgSentWithinWindow,
      sentAfterWindow: fcgSentAfterWindow,
      openOverdue: fcgOpenOverdue,
      withinWindowRate,
    },
    regeneration: {
      childDrafts,
      draftsRegeneratedAtLeastOnce: parentIdsReferenced.size,
      rate: regenRate,
    },
    latency: {
      avgProducedToSentMin: avgSentLatencyMin,
      avgProducedToDiscardedMin: null,
    },
    byMembership: topByMembership,
  };
}
