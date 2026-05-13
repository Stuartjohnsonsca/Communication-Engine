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
};

const PERCENTILES = { p50: 0.5, p90: 0.9 } as const;

export async function computeAdherenceMetrics(input: {
  tenantId: string;
  windowDays?: AdherenceMetricsWindow;
  /** Scope to a single sender — non-firm-wide self-view. */
  membershipId?: string;
  /** Override now — tests pin a deterministic clock. */
  now?: Date;
}): Promise<AdherenceMetrics> {
  const windowDays = input.windowDays ?? 30;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // Narrow query — SQL predicates apply scope + escalation gate so
  // non-escalated adherence rows (scored-but-OK sends) don't get
  // fetched only to drop them. Same "bytes we'd only drop in-app
  // aren't fetched" rule as items 69 / 76 / 78 / 89.
  const rows = await superDb.communicationAdherence.findMany({
    where: {
      tenantId: input.tenantId,
      ...(input.membershipId ? { membershipId: input.membershipId } : {}),
      escalatedAt: { not: null, gte: since, lt: now },
    },
    select: {
      escalatedAt: true,
      acknowledgedAt: true,
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
  const nowMs = now.getTime();

  for (const r of rows) {
    if (!r.escalatedAt) continue;
    escalated += 1;
    if (r.acknowledgedAt !== null) {
      acknowledged += 1;
      const duration = Math.max(
        0,
        r.acknowledgedAt.getTime() - r.escalatedAt.getTime(),
      );
      ackDurations.push(duration);
    } else {
      const ms = nowMs - r.escalatedAt.getTime();
      if (outstandingPositive(ms)) {
        if (oldestUnackedMs === null || ms > oldestUnackedMs) {
          oldestUnackedMs = ms;
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
