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
    /**
     * Post-PRD item 74 — the actual draft rows that constitute
     * `sentAfterWindow` and `openOverdue`, capped at
     * `RECENT_MISSES_LIMIT` rows per list, ordered by lateness
     * (most overdue first).
     *
     * The counters above tell a FIRM_ADMIN *that* the promise was
     * broken; this tells them *which* specific drafts so they can
     * act — DM the Member, send the open-overdue draft, or
     * investigate why it slipped. Sourced from the same per-row
     * `fcgBucket` classification as the counters so the two
     * surfaces can't disagree about which drafts count.
     */
    recentMisses: {
      sentAfterWindow: FcgMissRow[];
      openOverdue: FcgMissRow[];
    };
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
  /**
   * Top-N Memberships by `produced`. Membership label lookup is the
   * caller's responsibility (matches `/admin/usage` pattern).
   *
   * Item 67 — per-Member FCG-window adherence breakdown. Same rules as
   * the firm-wide block: bypassed-synth excluded, no-deadline excluded.
   * The point of having it per-Member is for the FIRM_ADMIN to act —
   * "the firm rate is 60%" is interesting; "Jane is at 30%, Sam at 95%"
   * is actionable.
   */
  byMembership: Array<{
    membershipId: string;
    produced: number;
    sent: number;
    discarded: number;
    open: number;
    fcgWindow: {
      sentWithDeadline: number;
      sentWithinWindow: number;
      sentAfterWindow: number;
      openOverdue: number;
      withinWindowRate: number | null;
    };
  }>;
};

/// Hard cap to prevent pathological row counts from melting the page.
/// A tenant sending 50k drafts in 30 days should move to server-side
/// aggregation (Prisma groupBy); current product scale is <1k/month.
const MAX_ROWS = 50_000;

/// Item 74 — recent-misses cap. Ten rows each side fits on one screen
/// without scrolling and matches the operator workflow: identify the
/// worst offenders, act on them, refresh. Exported so a future
/// per-window override can change it without refactor.
export const RECENT_MISSES_LIMIT = 10;

/**
 * Post-PRD item 74 — a single row inside `DraftRollup.fcgWindow.recentMisses`.
 *
 * `lateMs` is always positive. For `sentAfterWindow` rows it's
 * `sentMarkedAt - fcgWindowDeadline` (how late did we send?); for
 * `openOverdue` rows it's `now - fcgWindowDeadline` (how overdue is
 * it right now?). Same unit, same direction, so a single UI
 * formatter renders both. `status` is included so the operator can
 * see if an open-overdue draft is PROPOSED (not even reviewed),
 * EDITED (reviewed but not sent), or ACCEPTED (queued to send) —
 * each demands different follow-up.
 */
export type FcgMissRow = {
  draftId: string;
  membershipId: string | null;
  fcgWindowDeadline: Date;
  sentMarkedAt: Date | null;
  status: "PROPOSED" | "EDITED" | "ACCEPTED" | "SENT";
  lateMs: number;
};

/**
 * Post-PRD item 72 — FCG-window adherence rate over an arbitrary
 * `[since, until)` range. Used by the /admin/drafts trend pill to
 * compare current-period adherence against the immediately-prior
 * same-length window.
 *
 * Same exclusions as `computeDraftRollup`'s firm-wide FCG block (item
 * 66): bypassed-synth drafts and drafts without `fcgWindowDeadline`
 * never count toward the rate. SQL-side predicates so we don't fetch
 * rows we'd only drop in-app — mirrors item 69's narrow-query pattern.
 *
 * `withinWindowRate` is null when `sentWithDeadline === 0` — there's
 * no rate to report, and the caller should render "—" rather than 0%.
 * Same null-when-no-data invariant the rest of the codebase uses.
 *
 * Open-overdue is NOT computed here because the prior-period query
 * doesn't snapshot a single "now" relative to the historic range —
 * "what was open and overdue 14 days ago" requires a different query
 * shape (status as of that timestamp) and isn't load-bearing for the
 * trend pill, which is rate-vs-rate only.
 */
/// The per-membership shape inside `FcgAdherenceForRange.perMember`.
/// Same aggregate fields as the firm-wide level — the table on
/// /admin/drafts can render both with one component. Doesn't recurse
/// (no perMember inside perMember).
export type FcgMemberAdherenceForRange = {
  sentWithDeadline: number;
  sentWithinWindow: number;
  sentAfterWindow: number;
  withinWindowRate: number | null;
};

export type FcgAdherenceForRange = FcgMemberAdherenceForRange & {
  /**
   * Post-PRD item 75 — per-Member breakdown over the same range,
   * keyed by `membershipId`. Built in the same scan as the firm-wide
   * aggregate so the two surfaces use one classifier (mirrors item
   * 67's invariant: per-Member counters can't drift from firm-wide).
   *
   * Members with zero deadlined sends in the range are NOT present
   * in the map (not `{ sentWithDeadline: 0, withinWindowRate: null }`
   * entries). A caller looking up a missing member should treat
   * "absent" as "no comparison data" — the trend pill renders
   * nothing in that case, matching item 72's null-prior invariant.
   */
  perMember: Record<string, FcgMemberAdherenceForRange>;
};

export async function computeFcgAdherenceForRange(input: {
  tenantId: string;
  since: Date;
  until: Date;
}): Promise<FcgAdherenceForRange> {
  const rows = await superDb.draft.findMany({
    where: {
      tenantId: input.tenantId,
      createdAt: { gte: input.since, lt: input.until },
      synthesisedFromOutboundIngest: false,
      fcgWindowDeadline: { not: null },
      status: "SENT",
    },
    select: {
      membershipId: true,
      sentMarkedAt: true,
      fcgWindowDeadline: true,
    },
    take: MAX_ROWS,
  });

  let sentWithinWindow = 0;
  let sentAfterWindow = 0;
  // Item 75 — per-Member buckets accumulated in the same pass. Single
  // classifier ("was sent <= deadline?") drives both the firm-wide
  // counters and the per-Member ones.
  const perMemberBuckets = new Map<string, { within: number; after: number }>();
  for (const r of rows) {
    if (!r.fcgWindowDeadline || !r.sentMarkedAt) continue;
    const onTime = r.sentMarkedAt.getTime() <= r.fcgWindowDeadline.getTime();
    if (onTime) sentWithinWindow += 1;
    else sentAfterWindow += 1;
    if (r.membershipId) {
      const b = perMemberBuckets.get(r.membershipId) ?? { within: 0, after: 0 };
      if (onTime) b.within += 1;
      else b.after += 1;
      perMemberBuckets.set(r.membershipId, b);
    }
  }
  const sentWithDeadline = sentWithinWindow + sentAfterWindow;
  const perMember: Record<string, FcgMemberAdherenceForRange> = {};
  for (const [id, b] of perMemberBuckets) {
    const total = b.within + b.after;
    perMember[id] = {
      sentWithDeadline: total,
      sentWithinWindow: b.within,
      sentAfterWindow: b.after,
      withinWindowRate: total > 0 ? b.within / total : null,
    };
  }
  return {
    perMember,
    sentWithDeadline,
    sentWithinWindow,
    sentAfterWindow,
    withinWindowRate:
      sentWithDeadline > 0 ? sentWithinWindow / sentWithDeadline : null,
  };
}

/**
 * Convenience: the immediately-prior same-length window. For a 7d
 * call, returns adherence over the [-14d, -7d) range. Used by the
 * /admin/drafts trend pill to render the week-over-week delta. Same
 * null-when-no-data shape — when the prior window has no deadlined
 * sends the caller renders "no comparison available".
 */
export async function computePriorPeriodFcgRate(input: {
  tenantId: string;
  windowDays: number;
  now?: Date;
}): Promise<FcgAdherenceForRange> {
  const now = input.now ?? new Date();
  const windowMs = input.windowDays * 24 * 60 * 60 * 1000;
  const until = new Date(now.getTime() - windowMs);
  const since = new Date(until.getTime() - windowMs);
  return computeFcgAdherenceForRange({
    tenantId: input.tenantId,
    since,
    until,
  });
}

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
  // Item 67 — per-Member accumulators include the FCG-window block. The
  // shape mirrors the firm-wide block (sentWithDeadline / within / after
  // / openOverdue) so the page can render each Member identically.
  const byMembership = new Map<
    string,
    {
      produced: number;
      sent: number;
      discarded: number;
      open: number;
      fcgSentWithDeadline: number;
      fcgSentWithinWindow: number;
      fcgSentAfterWindow: number;
      fcgOpenOverdue: number;
    }
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

  // Item 74 — collect rows for the recent-misses panel. We push every
  // miss into these arrays during the scan, then sort by lateness and
  // slice at the end. Cost is bounded by the miss count, which is at
  // most `MAX_ROWS` and in practice dozens — a constant-time
  // operation against the existing single-pass scan.
  const sentAfterMisses: FcgMissRow[] = [];
  const openOverdueMisses: FcgMissRow[] = [];

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

    // Item 66 — FCG-window adherence (firm-wide). Bypassed-synth drafts
    // are excluded: they're post-hoc reconstructions of sends that
    // already happened outside the engine, so the "did we beat the
    // deadline" promise never applied. Drafts with no deadline are
    // excluded for the same reason: no promise, nothing to measure.
    //
    // Item 67 — the same classification applies per-Member; we capture
    // a single `fcgBucket` value here and use it to bump both the
    // firm-wide counters and the per-Member ones below, so the two
    // surfaces can't disagree about which drafts count.
    type FcgBucket = "within" | "after" | "openOverdue" | null;
    let fcgBucket: FcgBucket = null;
    if (source !== "bypassed_synth" && r.fcgWindowDeadline) {
      const deadline = r.fcgWindowDeadline.getTime();
      if (r.status === "SENT" && r.sentMarkedAt) {
        fcgBucket = r.sentMarkedAt.getTime() <= deadline ? "within" : "after";
      } else if (r.status !== "SENT" && r.status !== "DISCARDED") {
        if (deadline < now.getTime()) fcgBucket = "openOverdue";
      }
    }
    if (fcgBucket === "within") {
      fcgSentWithDeadline += 1;
      fcgSentWithinWindow += 1;
    } else if (fcgBucket === "after") {
      fcgSentWithDeadline += 1;
      fcgSentAfterWindow += 1;
      // Sourced from the same fcgBucket value as the counter — the
      // list and the count can't drift. `sentMarkedAt` and
      // `fcgWindowDeadline` are both proven non-null by the bucket
      // classification above, but the type is still nullable.
      if (r.sentMarkedAt && r.fcgWindowDeadline) {
        sentAfterMisses.push({
          draftId: r.id,
          membershipId: r.membershipId,
          fcgWindowDeadline: r.fcgWindowDeadline,
          sentMarkedAt: r.sentMarkedAt,
          // The `fcgBucket` classification guarantees status is one of
          // PROPOSED / EDITED / ACCEPTED (openOverdue) or SENT (after).
          // DISCARDED is excluded earlier. Narrowing here so the
          // FcgMissRow type stays operator-meaningful.
          status: r.status as Exclude<typeof r.status, "DISCARDED">,
          lateMs: r.sentMarkedAt.getTime() - r.fcgWindowDeadline.getTime(),
        });
      }
    } else if (fcgBucket === "openOverdue") {
      fcgOpenOverdue += 1;
      if (r.fcgWindowDeadline) {
        openOverdueMisses.push({
          draftId: r.id,
          membershipId: r.membershipId,
          fcgWindowDeadline: r.fcgWindowDeadline,
          sentMarkedAt: r.sentMarkedAt,
          // The `fcgBucket` classification guarantees status is one of
          // PROPOSED / EDITED / ACCEPTED (openOverdue) or SENT (after).
          // DISCARDED is excluded earlier. Narrowing here so the
          // FcgMissRow type stays operator-meaningful.
          status: r.status as Exclude<typeof r.status, "DISCARDED">,
          lateMs: now.getTime() - r.fcgWindowDeadline.getTime(),
        });
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
          fcgSentWithDeadline: 0,
          fcgSentWithinWindow: 0,
          fcgSentAfterWindow: 0,
          fcgOpenOverdue: 0,
        };
      existing.produced += 1;
      if (r.status === "SENT") existing.sent += 1;
      else if (r.status === "DISCARDED") existing.discarded += 1;
      else existing.open += 1;
      if (fcgBucket === "within") {
        existing.fcgSentWithDeadline += 1;
        existing.fcgSentWithinWindow += 1;
      } else if (fcgBucket === "after") {
        existing.fcgSentWithDeadline += 1;
        existing.fcgSentAfterWindow += 1;
      } else if (fcgBucket === "openOverdue") {
        existing.fcgOpenOverdue += 1;
      }
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
    .map(([membershipId, v]) => ({
      membershipId,
      produced: v.produced,
      sent: v.sent,
      discarded: v.discarded,
      open: v.open,
      fcgWindow: {
        sentWithDeadline: v.fcgSentWithDeadline,
        sentWithinWindow: v.fcgSentWithinWindow,
        sentAfterWindow: v.fcgSentAfterWindow,
        openOverdue: v.fcgOpenOverdue,
        withinWindowRate:
          v.fcgSentWithDeadline > 0
            ? v.fcgSentWithinWindow / v.fcgSentWithDeadline
            : null,
      },
    }));

  const withinWindowRate =
    fcgSentWithDeadline > 0 ? fcgSentWithinWindow / fcgSentWithDeadline : null;

  // Most-late first — the operator priority is "what's the worst
  // miss right now?" not "what's the freshest miss?". Recency is
  // already enforced by `windowDays`. Tie-break by deadline ascending
  // (older deadlines first) so identical-lateness rows have a stable
  // order rather than insertion order.
  const sortByLateness = (a: FcgMissRow, b: FcgMissRow) => {
    if (b.lateMs !== a.lateMs) return b.lateMs - a.lateMs;
    return a.fcgWindowDeadline.getTime() - b.fcgWindowDeadline.getTime();
  };
  sentAfterMisses.sort(sortByLateness);
  openOverdueMisses.sort(sortByLateness);

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
      recentMisses: {
        sentAfterWindow: sentAfterMisses.slice(0, RECENT_MISSES_LIMIT),
        openOverdue: openOverdueMisses.slice(0, RECENT_MISSES_LIMIT),
      },
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
