import { superDb } from "@/lib/db";

/**
 * Post-PRD hardening item 90 — adherence response-time observability.
 *
 * Adherence-pillar analog of item 78's sentiment response-time card. The
 * /adherence/escalations page lists raw rows + ack/open filter counts,
 * but until now it had no headline TTA gauge. This module supplies the
 * four numbers a FIRM_ADMIN / FCT_MEMBER actually wants at a glance:
 *
 *   - `acknowledgedRate` — fraction of in-window escalations that have
 *     been acked (NOT how many were "good sends," which is a different
 *     question — escalations are already below-threshold sends).
 *   - `medianAckMs` / `p90AckMs` — time-to-acknowledge percentiles.
 *   - `oldestUnackedMs` — oldest in-window escalation still outstanding.
 *
 * Time-to-acknowledge is `acknowledgedAt - escalatedAt`. Both fields
 * already exist on `CommunicationAdherence`; no schema change.
 *
 * Scope: `membershipId` (the sender on the adherence row) is optional.
 * When set, the metrics are scoped to escalations on that Member's own
 * sends — the self-view on /adherence/escalations. When omitted, metrics
 * span the full tenant — same split as the page's existing `firmWide`
 * branch. (Note the field name is `membershipId` not
 * `assignedToMembershipId`; sentiment routes to an assignee while
 * adherence escalates the sender of the bad send directly.)
 *
 * Window: 7 | 30 | 90 mirroring the established window selector across
 * /sentiment / /admin/drafts / /account. Default 30 — single mental
 * model: "30d compliance window" speaks to the same period everywhere.
 *
 * Null/empty handling: every aggregate returns `null` when its
 * denominator is zero, NOT a fake `0`. Matches the codebase-wide
 * null-when-no-data invariant (items 66 / 69 / 72 / 73 / 75 / 78). The
 * UI must render "—" rather than "0m TTA" which would falsely suggest
 * instantaneous response.
 *
 * Sister to item 89's `escalations-export.ts`: the export carries
 * per-row evidence; this module carries the aggregate gauge. Same SQL
 * predicate shape (`escalatedAt: { not: null, gte: since, lt: now }`)
 * so the two surfaces are talking about the same set of escalations.
 */

export type AdherenceMetricsWindow = 7 | 30 | 90;

export type AdherenceMetrics = {
  windowDays: number;
  /// Escalations whose `escalatedAt` falls in the window — the
  /// denominator for the acked-vs-total ratio and the TTA percentiles.
  escalated: number;
  /// Of those, how many have an `acknowledgedAt` set. Always
  /// `<= escalated`.
  acknowledged: number;
  /// `acknowledged / escalated`, range [0, 1]. Null when
  /// `escalated === 0` — no signal → no rate.
  acknowledgedRate: number | null;
  /// Median TTA across acked escalations, in ms. Null when
  /// `acknowledged === 0` — empty set has no median, and "0ms TTA"
  /// would falsely read as "instant ack."
  medianAckMs: number | null;
  /// 90th-percentile TTA. Same null rule as median.
  p90AckMs: number | null;
  /// `now - escalatedAt` for the oldest in-window unacked escalation
  /// (i.e. `escalatedAt >= since`). Null when no unacked exists or
  /// all unacked rows predate the window. The "in-window" scoping
  /// matters: a 90d-old unacked escalation shouldn't dominate a 7d
  /// view.
  oldestUnackedMs: number | null;
  /**
   * Post-PRD item 92 — per-Member breakdown. Present (possibly empty)
   * when the caller passed `withByMember: true`, undefined otherwise.
   * Built in the same scan as the firm-wide aggregate so the table on
   * /adherence/escalations can't disagree with the headline tiles about
   * which escalations counted (mirrors item 67's per-Member invariant
   * and item 80's sentiment-side equivalent: per-Member counters derive
   * from one classifier).
   *
   * **Adherence-pillar invariant — sum is exact**: every
   * `CommunicationAdherence` row has a non-null `membershipId` (the
   * sender of the scored send), so unlike sentiment — where unassigned
   * signals are excluded from per-Member but still count firm-wide —
   * per-Member escalated counts MUST sum to firm-wide `escalated`. A
   * drift here is a bug, not a triage-state quirk.
   */
  byMember?: MemberAdherenceMetrics[];
};

/**
 * Post-PRD item 92 — per-Member adherence response-time row. Adherence-
 * pillar analog of item 80's `MemberSentimentMetrics`. Same headline
 * fields as `AdherenceMetrics`, plus the bootstrap CI on the median,
 * plus the `lowVolume` flag for "we don't trust this number — too few
 * escalations to draw a conclusion."
 *
 * CI is on the median ONLY (not P90) — same rationale as item 80: P90
 * confidence intervals need 50+ samples to stabilise, and tail
 * behaviour can't be conjured by resampling. Adherence escalation
 * volumes per Member are typically lower than firm-wide sentiment
 * (only below-threshold sends escalate), so a P90 CI would always be
 * too wide to be useful.
 */
export type MemberAdherenceMetrics = {
  membershipId: string;
  /// In-window escalation count for THIS Member.
  escalated: number;
  /// Of those, how many were acked before the window's `asOf`.
  acknowledged: number;
  medianAckMs: number | null;
  /**
   * Bootstrap 95% confidence interval on `medianAckMs`. Null when
   * `acknowledged < BOOTSTRAP_MIN_N` (with 1-2 acked samples the CI
   * degenerates to a near-zero-width range and conveys false
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
  /// `true` when `escalated < MIN_SIGNALS_FLOOR`. Aggregates still
  /// render (the operator may want the count visible) but the UI
  /// flags the row so a 1-escalation "median 8h" doesn't read as a
  /// verdict.
  lowVolume: boolean;
};

/**
 * Volume floor below which a Member's medians/percentiles aren't
 * trustworthy enough to act on. Exported so future per-tenant
 * sensitivity overrides can change it without refactor. 5 chosen to
 * match the sentiment-side `MIN_SIGNALS_FLOOR` (item 80) so a
 * FIRM_ADMIN reading /sentiment and /adherence/escalations applies
 * the same mental model — "fewer than 5 signals in the window =
 * don't act on the median yet" — across both pillars.
 */
export const MIN_SIGNALS_FLOOR = 5;

/**
 * Below this many acknowledged escalations, the bootstrap CI
 * degenerates: with n=1 the resample is always the same value; with
 * n=2 there are three possible distinct medians (a, midpoint, b) and
 * the CI is nearly always [a, b]. n=3 is the smallest sample where
 * bootstrap yields a meaningful interval. Mirrors item 80.
 */
export const BOOTSTRAP_MIN_N = 3;

/**
 * 500 resamples stabilises the 2.5%/97.5% percentile bounds on a
 * median to ~1% of their true value, well within the resolution we
 * render (minutes, hours). Same as item 80; if the value diverges
 * between pillars, the duplicated `bootstrapMedianCi95` lets one
 * tune independently.
 */
const BOOTSTRAP_ITERATIONS = 500;

const PERCENTILES = { p50: 0.5, p90: 0.9 } as const;

export async function computeAdherenceMetrics(input: {
  tenantId: string;
  windowDays?: AdherenceMetricsWindow;
  /** Scope to a single sender — non-firm-wide self-view. */
  membershipId?: string;
  /** Override now — tests pin a deterministic clock. */
  now?: Date;
  /**
   * Item 92 — when true, return `byMember` in the result. Firm-wide
   * callers (FCT/Admin view on /adherence/escalations) set this; self-
   * view callers leave it false so the per-Member breakdown isn't
   * computed for a scope that has at most one Member.
   */
  withByMember?: boolean;
}): Promise<AdherenceMetrics> {
  const windowDays = input.windowDays ?? 30;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return computeAdherenceMetricsForRange({
    tenantId: input.tenantId,
    membershipId: input.membershipId,
    since,
    until: now,
    asOf: now,
    withByMember: input.withByMember,
  });
}

/**
 * Post-PRD item 91 — internal range helper. Same query + classification
 * logic as `computeAdherenceMetrics` but takes an explicit `[since,
 * until)` range so `computePriorPeriodAdherenceMetrics` can reuse it
 * without duplicating the percentile loop.
 *
 * `asOf` is the clock used for `oldestUnackedMs` and for the
 * "acknowledged-in-range" predicate:
 *   - CURRENT window callers pass `now` so the gauge reflects real
 *     outstanding age + every ack that's landed by request time counts.
 *   - PRIOR window callers pass the END of the prior window (`until`)
 *     so an ack landing AFTER the window closed (i.e. inside the
 *     current window) does NOT inflate the prior ack rate. Without this
 *     pin, "we improved" would falsely read as "we got worse"
 *     (item 79's load-bearing rule on the sentiment side).
 *
 * Mirrors `computeSentimentMetricsForRange` from item 79.
 */
async function computeAdherenceMetricsForRange(input: {
  tenantId: string;
  since: Date;
  until: Date;
  asOf: Date;
  membershipId?: string;
  withByMember?: boolean;
}): Promise<AdherenceMetrics> {
  const windowDays = Math.round(
    (input.until.getTime() - input.since.getTime()) / (24 * 60 * 60 * 1000),
  );

  // Narrow query — SQL predicates apply scope + escalation gate so
  // non-escalated adherence rows (scored-but-OK sends) don't get
  // fetched only to drop them. Same "bytes we'd only drop in-app
  // aren't fetched" rule as items 69 / 76 / 78 / 89.
  //
  // Item 92 — `membershipId` is selected only when `withByMember` is
  // true, mirroring item 80's conditional select on
  // `assignedToMembershipId`. Unlike sentiment, the column is non-null
  // on this table, so the runtime cast is safe without a fallback.
  const rows = await superDb.communicationAdherence.findMany({
    where: {
      tenantId: input.tenantId,
      ...(input.membershipId ? { membershipId: input.membershipId } : {}),
      escalatedAt: { not: null, gte: input.since, lt: input.until },
    },
    select: {
      escalatedAt: true,
      acknowledgedAt: true,
      ...(input.withByMember ? { membershipId: true } : {}),
    },
    // Defensive cap — adherence escalations could spike during a
    // regression but 50k in a 90d window is generous at typical
    // tenant scale. Matches items 66 / 76 / 78 / 89.
    take: 50_000,
  });

  let escalated = 0;
  let acknowledged = 0;
  const ackDurations: number[] = [];
  let oldestUnackedMs: number | null = null;
  const asOfMs = input.asOf.getTime();

  // Item 92 — per-Member accumulators. Built from the SAME per-row
  // classification (`ackedInRange` + outstanding-positive check) that
  // bumps the firm-wide counters, so the two surfaces can't drift.
  // Mirror of item 80's sentiment-side buckets; the only behavioural
  // delta is that adherence's `membershipId` is non-null, so every
  // counted row contributes to exactly one Member bucket — per-Member
  // sums MUST equal the firm-wide total (asserted in tests).
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
    // For prior-window callers: only count acks landed BEFORE the
    // prior window closed. An ack inside the CURRENT window (i.e.
    // after `asOf` for prior callers) is current-window evidence, not
    // prior evidence (item 79's invariant).
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
      // The select only includes `membershipId` when withByMember=true,
      // so the field is present at runtime; the cast keeps TS honest
      // about that conditional select shape. The column is NOT NULL on
      // this table — see schema.prisma — so no null branch is needed.
      const mid = (r as { membershipId?: string }).membershipId!;
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

  const byMember: MemberAdherenceMetrics[] | undefined = byMemberBuckets
    ? Array.from(byMemberBuckets.entries()).map(([membershipId, b]) => ({
        membershipId,
        escalated: b.escalated,
        acknowledged: b.acknowledged,
        medianAckMs: percentile(b.ackDurations, PERCENTILES.p50),
        // Bootstrap CI is seeded deterministically per Member from
        // their own data so a refresh on the same numbers produces
        // the same bounds — operators don't see the interval bobble
        // between consecutive page loads (mirrors item 80).
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
 * Post-PRD item 91 — adherence trend pill prior-period snapshot. Same
 * `AdherenceMetrics` shape as the current call but for the immediately-
 * prior same-length window. For a 30d call, prior = `[now-60d, now-30d)`.
 * Current and prior never overlap (the cutoff is `now - windowDays`,
 * used as `until` of prior and `since` of current).
 *
 * `asOf` pinned to `until` so:
 *   - `oldestUnackedMs` reads as "how long had this signal been
 *     outstanding when the prior window closed?" — without that pin, an
 *     unacked row from 40d ago would always read as "40d outstanding"
 *     instead of however old it was when its window ended.
 *   - An ack landing inside the current window doesn't get credited to
 *     prior — otherwise "we improved" would falsely read "we got worse."
 *
 * Renders nothing in the UI when current OR prior is null OR prior
 * escalated === 0 (same null-prior invariant as items 72/73/75/79/88).
 * Mirrors `computePriorPeriodSentimentMetrics` from item 79.
 */
export async function computePriorPeriodAdherenceMetrics(input: {
  tenantId: string;
  windowDays?: AdherenceMetricsWindow;
  membershipId?: string;
  now?: Date;
  /**
   * Item 92 — mirror of item 88's sentiment-side option. Present for
   * shape parity with the current-window helper; today no page surface
   * consumes the prior-window per-Member breakdown (the
   * /adherence/escalations table doesn't render a per-Member trend pill
   * yet — that'd be a separate item analogous to item 88). When a future
   * item wires up a per-Member trend pill it can opt in here without a
   * lib refactor.
   */
  withByMember?: boolean;
}): Promise<AdherenceMetrics> {
  const windowDays = input.windowDays ?? 30;
  const now = input.now ?? new Date();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const until = new Date(now.getTime() - windowMs);
  const since = new Date(until.getTime() - windowMs);
  return computeAdherenceMetricsForRange({
    tenantId: input.tenantId,
    membershipId: input.membershipId,
    since,
    until,
    asOf: until,
    withByMember: input.withByMember,
  });
}

function outstandingPositive(ms: number): boolean {
  // A row escalated 1ms ago is technically "unacked" but sub-second
  // outstanding-time is rendering noise. Mirror of item 78's filter.
  return ms > 1000;
}

/**
 * Linear-interpolation percentile. Inline rather than imported because
 * the codebase already has two near-identical copies (sentiment metrics
 * + this module); a shared "stats" utility module isn't worth the
 * cross-module entanglement yet — same duplicate-threshold rule the
 * codebase applies elsewhere (items 68 / 70 / 73 / 75 / 88). If a third
 * pillar grows a percentile call site, extract.
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
 * Post-PRD item 92 — bootstrap 95% CI on the median of an ack-duration
 * array. Adherence-pillar duplicate of item 80's
 * `bootstrapMedianCi95` in `@/lib/sentiment/metrics`. Duplicating
 * preserves pillar independence — if a future per-pillar sensitivity
 * change wants to tune `BOOTSTRAP_ITERATIONS` (or use a different
 * resampler) on one side without disturbing the other, the seam is
 * already where it needs to be. The codebase's duplicate-at-two,
 * extract-at-three rule (items 68 / 70 / 73 / 75 / 88) applies: a
 * third bootstrap site would be the natural extraction trigger into
 * a shared stats util.
 *
 * Exported for direct testing with a known seed; the production path
 * always routes through `computeAdherenceMetricsForRange` which seeds
 * deterministically from the data array.
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
    // Reuses the same `percentile` helper as the headline median so
    // the CI bracket can't disagree on the median definition.
    const resample = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      resample[i] = durations[Math.floor(random() * n)]!;
    }
    samples[b] = percentile(resample, PERCENTILES.p50)!;
  }
  samples.sort((a, b) => a - b);
  const loIdx = Math.floor(0.025 * BOOTSTRAP_ITERATIONS);
  const hiIdx = Math.ceil(0.975 * BOOTSTRAP_ITERATIONS) - 1;
  return { loMs: samples[loIdx]!, hiMs: samples[hiIdx]! };
}

/**
 * Seeded LCG (numerical recipes constants). Mirror of item 80 in
 * `@/lib/sentiment/metrics` — deterministic across runs for the same
 * seed, adequate for bootstrap resampling (no cryptographic
 * requirement, just an unbiased uniform draw).
 */
function seededPrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Derive a stable seed from a duration array so the bootstrap CI for
 * the same Member's data is reproducible across page refreshes.
 * Identical Members with identical data share a CI (correct: the CI
 * is a function of the data); small changes (one new ack) scramble
 * the resample sequence. Mirror of item 80.
 */
function seedFromDurations(durations: number[]): number {
  let s = durations.length;
  for (const d of durations) {
    s = (Math.imul(s, 31) + (d | 0)) >>> 0;
  }
  return s === 0 ? 1 : s;
}
