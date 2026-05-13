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
  /**
   * Post-PRD item 80 — per-Member breakdown. Present (possibly empty)
   * when the caller passed `withByMember: true`, undefined otherwise.
   * Built in the same scan as the firm-wide aggregate so the table on
   * /sentiment can't disagree with the headline tiles about which
   * signals counted (mirrors item 67's invariant: per-Member counters
   * derive from one classifier).
   *
   * Members with zero in-window signals do NOT appear (the FIRM_ADMIN
   * doesn't need a "Bob: 0 signals" row cluttering the table).
   * Members whose only signals lack an `assignedToMembershipId` also
   * don't appear — unassigned signals are a separate triage problem,
   * not a per-Member performance signal.
   */
  byMember?: MemberSentimentMetrics[];
};

/**
 * Post-PRD item 80 — per-Member response-time breakdown row.
 *
 * Same headline fields as `SentimentMetrics`, plus the bootstrap CI
 * on the median, plus the `lowVolume` flag for "we don't trust this
 * number — too few signals to draw a conclusion."
 *
 * The CI is intentionally on the median ONLY: P90 confidence intervals
 * from a bootstrap need 50+ samples to be stable (the tail behaviour
 * is what we're trying to characterise, and resampling can't conjure
 * tail data that wasn't there). Sentiment volumes are tens-per-tenant,
 * so a P90 CI would always be too wide to be useful.
 */
export type MemberSentimentMetrics = {
  membershipId: string;
  /// In-window escalation count for THIS Member.
  escalated: number;
  /// Of those, how many were acked before the window's `asOf`.
  acknowledged: number;
  medianAckMs: number | null;
  /**
   * Bootstrap 95% confidence interval on `medianAckMs`. Null when
   * `acknowledged < BOOTSTRAP_MIN_N` (with only 1-2 acked samples, the
   * CI degenerates to a near-zero-width range and conveys false
   * precision). When non-null, `loMs <= medianAckMs <= hiMs`.
   *
   * Computed by resampling the Member's `ackDurations` array with
   * replacement `BOOTSTRAP_ITERATIONS` times, taking the median of
   * each resample, and reading the 2.5th and 97.5th percentiles of
   * the resulting distribution. The PRNG is SEEDED — page refreshes
   * with the same data produce the same CI (no flickering bounds,
   * deterministic tests).
   */
  medianAckCi95: { loMs: number; hiMs: number } | null;
  p90AckMs: number | null;
  oldestUnackedMs: number | null;
  /// `true` when `escalated < MIN_SIGNALS_FLOOR`. The aggregates are
  /// still computed (the operator may still want the count visible);
  /// the UI uses this to render a clear "insufficient data" badge
  /// instead of letting a 1-signal "median 8h" read as a verdict.
  lowVolume: boolean;
};

/**
 * Volume floor below which a Member's medians/percentiles aren't
 * trustworthy enough to act on. Exported so future per-tenant
 * sensitivity overrides can change it without refactor. 5 chosen to
 * match the "small but non-trivial" threshold pattern from item 71
 * (`MIN_DEADLINED_SENDS = 10`) — sentiment volumes are lower than
 * adherence volumes, so 5 is the equivalent stability floor.
 */
export const MIN_SIGNALS_FLOOR = 5;

/**
 * Below this many acknowledged signals, the bootstrap CI degenerates:
 * with n=1 the resample is always the same value; with n=2 there are
 * three possible distinct medians (a, midpoint, b) and the CI is
 * nearly always [a, b]. n=3 is the smallest sample where bootstrap
 * yields a meaningful interval.
 */
export const BOOTSTRAP_MIN_N = 3;

/**
 * 500 resamples is enough to stabilise the 2.5%/97.5% percentile
 * bounds on a median to ~1% of their true value — well within the
 * resolution we render (minutes, hours). 1000+ adds compute without
 * changing what the operator sees. Cost per Member is O(B * n) where
 * n is the Member's ack count; for a tenant with 10 Members × 30
 * signals × 500 resamples that's 150k operations — trivial.
 */
const BOOTSTRAP_ITERATIONS = 500;

const PERCENTILES = { p50: 0.5, p90: 0.9 } as const;

export async function computeSentimentMetrics(input: {
  tenantId: string;
  windowDays?: SentimentMetricsWindow;
  /** Scope to a single assignee — non-firm-wide self-view. */
  assignedToMembershipId?: string;
  /** Override now — tests pin a deterministic clock. */
  now?: Date;
  /**
   * Item 80 — when true, return `byMember` in the result. Firm-wide
   * callers (FCT/Admin view on /sentiment) set this; self-view callers
   * leave it false so the per-Member breakdown isn't computed for a
   * scope that always has exactly one Member.
   */
  withByMember?: boolean;
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
    withByMember: input.withByMember,
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
  withByMember?: boolean;
}): Promise<SentimentMetrics> {
  const windowDays = Math.round(
    (input.until.getTime() - input.since.getTime()) / (24 * 60 * 60 * 1000),
  );

  // Narrow query — only escalated signals whose `escalatedAt` falls in
  // [since, until) contribute. SQL predicates apply scope + escalation
  // gate so we don't fetch non-escalated rows only to drop them.
  // Item 80 — when `withByMember` is true we also need
  // `assignedToMembershipId` to bucket per-Member; otherwise we don't
  // select it (saves a column we'd never read).
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
      ...(input.withByMember ? { assignedToMembershipId: true } : {}),
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

  // Item 80 — per-Member accumulators. Built from the SAME per-row
  // classification (`ackedInRange` + outstanding-positive check) that
  // bumps the firm-wide counters, so the two surfaces can't drift.
  // Unassigned signals (`assignedToMembershipId === null`) are
  // EXCLUDED from per-Member buckets but still contribute to the
  // firm-wide aggregate — unassigned-triage is a separate problem.
  type MemberBucket = {
    escalated: number;
    acknowledged: number;
    ackDurations: number[];
    oldestUnackedMs: number | null;
  };
  const byMemberBuckets = input.withByMember
    ? new Map<string, MemberBucket>()
    : null;

  for (const r of rows) {
    if (!r.escalatedAt) continue;
    escalated += 1;
    // For the prior-window pill we only credit an acknowledgement that
    // landed BEFORE the window closed — otherwise a signal escalated on
    // day 14 and acked on day 7 (current window) would inflate the
    // prior-window ack rate.
    const ackedInRange =
      r.acknowledgedAt !== null && r.acknowledgedAt.getTime() < asOfMs;
    let duration: number | null = null;
    let outstanding: number | null = null;
    if (ackedInRange) {
      acknowledged += 1;
      duration = Math.max(
        0,
        r.acknowledgedAt!.getTime() - r.escalatedAt.getTime(),
      );
      ackDurations.push(duration);
    } else {
      const ms = asOfMs - r.escalatedAt.getTime();
      if (outstandingPositive(ms)) {
        outstanding = ms;
        if (oldestUnackedMs === null || ms > oldestUnackedMs) {
          oldestUnackedMs = ms;
        }
      }
    }

    if (byMemberBuckets) {
      // The select only includes `assignedToMembershipId` when
      // withByMember=true, so the field is present at runtime; the
      // cast keeps TS honest about that conditional select shape.
      const mid = (r as { assignedToMembershipId?: string | null })
        .assignedToMembershipId;
      if (mid) {
        const b: MemberBucket = byMemberBuckets.get(mid) ?? {
          escalated: 0,
          acknowledged: 0,
          ackDurations: [],
          oldestUnackedMs: null,
        };
        b.escalated += 1;
        if (duration !== null) {
          b.acknowledged += 1;
          b.ackDurations.push(duration);
        } else if (outstanding !== null) {
          if (b.oldestUnackedMs === null || outstanding > b.oldestUnackedMs) {
            b.oldestUnackedMs = outstanding;
          }
        }
        byMemberBuckets.set(mid, b);
      }
    }
  }

  const byMember: MemberSentimentMetrics[] | undefined = byMemberBuckets
    ? Array.from(byMemberBuckets.entries()).map(([membershipId, b]) => ({
        membershipId,
        escalated: b.escalated,
        acknowledged: b.acknowledged,
        medianAckMs: percentile(b.ackDurations, PERCENTILES.p50),
        // Bootstrap CI is seeded deterministically per Member from
        // their own data so a refresh on the same numbers produces
        // the same bounds — operators don't see the interval bobble
        // between two consecutive page loads.
        medianAckCi95: bootstrapMedianCi95(
          b.ackDurations,
          seededPrng(seedFromDurations(b.ackDurations)),
        ),
        p90AckMs: percentile(b.ackDurations, PERCENTILES.p90),
        oldestUnackedMs: b.oldestUnackedMs,
        lowVolume: b.escalated < MIN_SIGNALS_FLOOR,
      }))
    : undefined;

  return {
    windowDays,
    escalated,
    acknowledged,
    acknowledgedRate: escalated > 0 ? acknowledged / escalated : null,
    medianAckMs: percentile(ackDurations, PERCENTILES.p50),
    p90AckMs: percentile(ackDurations, PERCENTILES.p90),
    oldestUnackedMs,
    byMember,
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
 * Re-exported under the historical name so existing call sites
 * (`/sentiment` page, `/account`, `firm-ack-monitor.ts`, and the
 * `sentiment-metrics.test.ts` suite) keep working unchanged. The
 * implementation now lives in `@/lib/format/duration` — item 87
 * extracted it after the fifth caller (the new `<LiveDeadline />`
 * /drafts countdown) tripped the duplication threshold telegraphed
 * by items 78 / 82 / 83.
 */
export { formatDurationOrDash as formatTtaDuration } from "@/lib/format/duration";

/**
 * Post-PRD item 80 — bootstrap 95% CI on the median of an ack-duration
 * array. Returns null below `BOOTSTRAP_MIN_N` because the interval
 * degenerates at tiny sample sizes (see `BOOTSTRAP_MIN_N` doc).
 *
 * Exported for direct testing with a known seed; the production path
 * always goes through `computeSentimentMetricsForRange` which seeds
 * deterministically from the data.
 */
export function bootstrapMedianCi95(
  durations: number[],
  random: () => number,
): { loMs: number; hiMs: number } | null {
  const n = durations.length;
  if (n < BOOTSTRAP_MIN_N) return null;
  const samples = new Array<number>(BOOTSTRAP_ITERATIONS);
  for (let b = 0; b < BOOTSTRAP_ITERATIONS; b++) {
    // Resample with replacement, then read the median of the resample.
    // We reuse the `percentile` helper so resampled medians use the
    // same linear-interpolation definition as the headline median —
    // mixing definitions here would let the CI bracket NOT contain
    // the headline median.
    const resample = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      resample[i] = durations[Math.floor(random() * n)]!;
    }
    samples[b] = percentile(resample, PERCENTILES.p50)!;
  }
  samples.sort((a, b) => a - b);
  // 2.5% / 97.5% percentiles of the bootstrap distribution.
  const loIdx = Math.floor(0.025 * BOOTSTRAP_ITERATIONS);
  const hiIdx = Math.ceil(0.975 * BOOTSTRAP_ITERATIONS) - 1;
  return { loMs: samples[loIdx]!, hiMs: samples[hiIdx]! };
}

/**
 * Seeded LCG (numerical recipes constants). Deterministic across runs
 * for the same seed. Adequate for bootstrap resampling — we don't
 * need cryptographic randomness, just an unbiased uniform draw.
 *
 * Not exported for use elsewhere — if another caller needs a seeded
 * PRNG, extract into a shared util at that point.
 */
function seededPrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Derive a stable seed from a duration array so the bootstrap CI
 * for the same Member's data is reproducible across page refreshes.
 * Hashing the sum-of-durations is enough — two distinct Members with
 * identical ack-duration arrays will share a CI (correct: the CI
 * depends only on the data), and small changes (one new ack) shift
 * the seed enough to scramble the resample sequence.
 */
function seedFromDurations(durations: number[]): number {
  let s = durations.length;
  for (const d of durations) {
    // Mix in milliseconds; bit-rotate to spread entropy across the
    // 32-bit word so two arrays with the same sum but different
    // composition produce different seeds.
    s = (Math.imul(s, 31) + (d | 0)) >>> 0;
  }
  // Bias the seed away from 0 (LCG output for seed=0 is just the
  // constant — not catastrophic but degrades the spread of resamples).
  return s === 0 ? 1 : s;
}
