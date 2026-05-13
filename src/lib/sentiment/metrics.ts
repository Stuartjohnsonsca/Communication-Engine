import { superDb } from "@/lib/db";

/**
 * Post-PRD hardening item 78 — sentiment response-time observability.
 *
 * The /sentiment page shows the list of signals + the filter chips
 * with raw counts (escalated, extreme-neg, extreme-pos, neutral).
 * What it doesn't surface is the firm's actual response speed:
 *   - Median time-to-acknowledge (TTA) over the window.
 *   - P90 TTA (long-tail signal — are some sitting much longer?).
 *   - Oldest currently-unacked escalation.
 *   - Acked-vs-total ratio (how many of the escalations from this
 *     window have been actioned).
 *
 * Time-to-acknowledge is `acknowledgedAt - escalatedAt`. Both fields
 * already exist on `SentimentSignal`; no schema change.
 *
 * Scope: `assignedToMembershipId` is optional. When set, the metrics
 * are scoped to a single Membership (the self-view on /sentiment for
 * non-firm-wide roles). When omitted, metrics span the full tenant
 * — same split as the page's existing `firmWide` flag.
 *
 * Window: `windowDays` is `7 | 30 | 90` mirroring the /admin/drafts
 * window selector. Default 30 — matches the per-Member adherence
 * default (item 69) so the surfaces speak the same period.
 *
 * Null/empty handling: every aggregate returns `null` when its
 * denominator is zero, NOT a fake `0`. Matches the codebase-wide
 * null-when-no-data invariant (items 66, 69, 72, 73, 75). The UI
 * renders "—" rather than "0m TTA," which would falsely suggest
 * instantaneous response.
 */

export type SentimentMetricsWindow = 7 | 30 | 90;

export type SentimentMetrics = {
  windowDays: number;
  /// Signals with `escalatedAt` in the window. The denominator for
  /// the acked-vs-total ratio and the TTA percentiles.
  escalated: number;
  /// Of those, how many have an `acknowledgedAt` set. Always
  /// `<= escalated`.
  acknowledged: number;
  /// `acknowledged / escalated`, range [0, 1]. Null when
  /// `escalated === 0` (no signal → no rate to report).
  acknowledgedRate: number | null;
  /// Median time-to-acknowledge across acked signals, in ms. Null
  /// when `acknowledged === 0` — there's no median over an empty set
  /// and the UI must not show "0ms TTA" (would read as "instant"
  /// even though no signals were processed).
  medianAckMs: number | null;
  /// 90th-percentile TTA. Same null rule as the median. Useful for
  /// the long tail — a 1h median with a 24h p90 means most
  /// escalations are fast but some sit for a day.
  p90AckMs: number | null;
  /// `now - escalatedAt` for the oldest unacked escalation IN window
  /// (i.e. `escalatedAt >= since`). Null when no unacked
  /// escalation exists or all unacked ones predate the window. The
  /// "in-window" scoping matters: a 90d-old unacked signal
  /// shouldn't dominate a 7d view.
  oldestUnackedMs: number | null;
};

const PERCENTILES = { p50: 0.5, p90: 0.9 } as const;

export async function computeSentimentMetrics(input: {
  tenantId: string;
  windowDays?: SentimentMetricsWindow;
  /** Scope to a single assignee — non-firm-wide self-view. */
  assignedToMembershipId?: string;
  /** Override now — tests pin a deterministic clock. */
  now?: Date;
}): Promise<SentimentMetrics> {
  const windowDays = input.windowDays ?? 30;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return computeSentimentMetricsForRange({
    tenantId: input.tenantId,
    assignedToMembershipId: input.assignedToMembershipId,
    since,
    until: now,
    asOf: now,
  });
}

/**
 * Post-PRD item 79 — internal helper that takes an explicit `[since,
 * until)` range, so the `computePriorPeriodSentimentMetrics` helper can
 * reuse the same query + classification logic without duplicating the
 * percentile loop.
 *
 * `asOf` is the clock used for `oldestUnackedMs` — when computing the
 * CURRENT window, callers pass `now` so the gauge reflects real
 * outstanding age. When computing the PRIOR window for a trend pill,
 * callers pass the END of the prior window (`until`) so the result
 * answers "how long had this signal been outstanding when this prior
 * window closed?" — without that, an unacked signal from 14 days ago
 * would always read as "14d outstanding" instead of however old it was
 * when its window ended.
 */
async function computeSentimentMetricsForRange(input: {
  tenantId: string;
  since: Date;
  until: Date;
  asOf: Date;
  assignedToMembershipId?: string;
}): Promise<SentimentMetrics> {
  const windowDays = Math.round(
    (input.until.getTime() - input.since.getTime()) / (24 * 60 * 60 * 1000),
  );

  // Narrow query — only escalated signals whose `escalatedAt` falls in
  // [since, until) contribute. SQL predicates apply scope + escalation
  // gate so we don't fetch non-escalated rows only to drop them.
  const rows = await superDb.sentimentSignal.findMany({
    where: {
      tenantId: input.tenantId,
      ...(input.assignedToMembershipId
        ? { assignedToMembershipId: input.assignedToMembershipId }
        : {}),
      escalatedAt: { not: null, gte: input.since, lt: input.until },
    },
    select: {
      escalatedAt: true,
      acknowledgedAt: true,
    },
    // Defensive cap — sentiment volumes are low (tens-to-hundreds per
    // tenant per month) so 50k is generous.
    take: 50_000,
  });

  let escalated = 0;
  let acknowledged = 0;
  const ackDurations: number[] = [];
  let oldestUnackedMs: number | null = null;
  const asOfMs = input.asOf.getTime();

  for (const r of rows) {
    if (!r.escalatedAt) continue;
    escalated += 1;
    // For the prior-window pill we only credit an acknowledgement that
    // landed BEFORE the window closed — otherwise a signal escalated on
    // day 14 and acked on day 7 (current window) would inflate the
    // prior-window ack rate.
    const ackedInRange =
      r.acknowledgedAt !== null && r.acknowledgedAt.getTime() < asOfMs;
    if (ackedInRange) {
      acknowledged += 1;
      const dt = r.acknowledgedAt!.getTime() - r.escalatedAt.getTime();
      // Negative durations would only happen with a clock skew or a
      // manually-poked row; floor at 0 so percentile math stays sane.
      ackDurations.push(Math.max(0, dt));
    } else {
      const outstanding = asOfMs - r.escalatedAt.getTime();
      if (outstandingPositive(outstanding)) {
        if (oldestUnackedMs === null || outstanding > oldestUnackedMs) {
          oldestUnackedMs = outstanding;
        }
      }
    }
  }

  return {
    windowDays,
    escalated,
    acknowledged,
    acknowledgedRate: escalated > 0 ? acknowledged / escalated : null,
    medianAckMs: percentile(ackDurations, PERCENTILES.p50),
    p90AckMs: percentile(ackDurations, PERCENTILES.p90),
    oldestUnackedMs,
  };
}

/**
 * Post-PRD item 79 — sentiment response-time trend pill prior-period
 * snapshot. Returns the same `SentimentMetrics` shape for the
 * immediately-prior same-length window, so the /sentiment card can
 * render direction pills next to the headline tiles.
 *
 * For a 30d call, prior = `[now - 60d, now - 30d)`. Current and prior
 * never overlap (the `until` of prior equals the `since` of current).
 *
 * **`asOf` is pinned to the END of the prior window**, not `now` —
 * otherwise:
 *   - `oldestUnackedMs` would always equal the full age of any unacked
 *     prior-window signal (it's been sitting from then until now, which
 *     is by definition longer than the window itself).
 *   - An acknowledgement that landed inside the current window would
 *     count toward the prior window's ack rate, falsely inflating it.
 *
 * Pinning `asOf = until` answers the meaningful question: "at the point
 * this window closed, how were we doing?"
 *
 * Same null-when-no-data invariant as `computeSentimentMetrics`. When
 * prior is empty, the trend pill renders nothing (don't fake a delta
 * against missing data — matches items 72/73/75).
 */
export async function computePriorPeriodSentimentMetrics(input: {
  tenantId: string;
  windowDays?: SentimentMetricsWindow;
  assignedToMembershipId?: string;
  now?: Date;
}): Promise<SentimentMetrics> {
  const windowDays = input.windowDays ?? 30;
  const now = input.now ?? new Date();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const until = new Date(now.getTime() - windowMs);
  const since = new Date(until.getTime() - windowMs);
  return computeSentimentMetricsForRange({
    tenantId: input.tenantId,
    assignedToMembershipId: input.assignedToMembershipId,
    since,
    until,
    asOf: until,
  });
}

function outstandingPositive(ms: number): boolean {
  // A signal escalated 1ms ago is technically "unacked" but reporting
  // sub-second outstanding-time is noise. Below-1s rounds to 0 in the
  // UI anyway; including it here would just trigger "0m outstanding"
  // labels on a fresh signal.
  return ms > 1000;
}

/**
 * Linear-interpolation percentile. For tiny samples (n < 10) p50/p90
 * are mostly determined by the highest few values — that's fine for
 * an operator-facing metric. Returns null on empty input.
 *
 * Inline rather than imported because we have one caller and don't
 * want a "stats" utility module to grow accidentally.
 */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

/**
 * Render a positive duration as `<1m` / `Nm` / `Nh` / `Nd`. Pure
 * formatter — shared between the page card and the metrics tooltip.
 * Mirrors the `formatLateBy` formatter from drafts (item 74 page +
 * item 76 CSV); at three sites the duplication threshold flips and
 * the helper should be extracted into a shared module.
 */
export function formatTtaDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 60_000) return "<1m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(ms / (60 * 60_000));
  if (hours < 48) return `${hours}h`;
  const days = Math.round(ms / (24 * 60 * 60_000));
  return `${days}d`;
}
