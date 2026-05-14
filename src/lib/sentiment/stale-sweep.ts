import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchSentimentEscalationStale } from "@/lib/notifications/immediate";
import { reportError } from "@/lib/observability";

/**
 * Post-PRD hardening item 77 — stale-sentiment-escalation sweeper.
 *
 * PRD §9.3 routes extreme-negative-about-firm-handling inbound through
 * `classifyAndRecordInbound`, which fires `sentiment_escalation`
 * immediately to the assigned User + FCT + FIRM_ADMIN. If nobody
 * acknowledges within `STALE_THRESHOLD_HOURS`, the escalation has been
 * silently dropped — a counterparty complaint, possibly regulatory,
 * sitting in an inbox. This sweep is the second-chance nudge.
 *
 * Mirrors item 54's draft-stale pattern with two adjustments for the
 * sentiment surface:
 *   1. Recipients are firm-wide (assigned User + FCT + FIRM_ADMIN) not
 *      just the owning Membership — the original escalation is also
 *      firm-wide and a draft is a different operational shape.
 *   2. Cadence is hourly (recommended), not daily. The complaint is
 *      time-sensitive; a 24h tick-cycle could leave a signal unacked
 *      for ~30h before the nudge lands.
 *
 * Skip conditions:
 *   - `escalatedAt` is null — not escalated, nothing to nudge.
 *   - `escalatedAt` is more recent than `STALE_THRESHOLD_HOURS` ago —
 *     not yet stale.
 *   - `acknowledgedAt` is non-null — already actioned.
 *   - Audit chain already has a `SENTIMENT_ESCALATION_STALE_WARNED`
 *     row for this signal — already nudged in a prior cron tick.
 *
 * Notification kind `sentiment_escalation_stale` is mandatory. The
 * complaint IS the thing this notification surfaces, and muting it
 * would leave a §9.3 boundary unactioned with no second-chance signal.
 *
 * Audit event `SENTIMENT_ESCALATION_STALE_WARNED` lands on the tenant
 * chain. Audit FIRST, then fan out — mirrors item 71's invariant: the
 * chain reflects the trip even if every recipient dispatch fails (the
 * cron noticed; that's the load-bearing fact).
 */

export const STALE_THRESHOLD_HOURS = 4;

export type SentimentStaleSweepResult = {
  /// Escalated-and-unacked signals returned by the candidate query.
  scanned: number;
  /// First-time stale nudges dispatched this pass.
  warned: number;
  /// Audit chain already has a stale-warned row for this signal —
  /// counted but not re-actioned. Steady-state line on every tick.
  alreadyWarned: number;
  /// Skipped for any documented reason above.
  skipped: number;
  /// Persist / dispatch threw. Logged via reportError; sweep continues.
  errored: number;
};

export async function runSentimentStaleSweep(opts?: {
  /** Override "now" — tests pin a deterministic clock. */
  now?: Date;
  /** Restrict to a single tenant — tests / on-demand. */
  tenantId?: string;
}): Promise<SentimentStaleSweepResult> {
  const now = opts?.now ?? new Date();

  // Item 100 — per-tenant override on `staleThresholdHours`. The
  // sweep iterates tenants in two passes: (1) candidate query for any
  // tenant whose strictest possible cutoff is past (i.e. PLATFORM
  // default), then (2) per-tenant filter using each tenant's
  // effective threshold. Single-pass with the platform default would
  // miss tenants that LOOSENED the threshold (e.g. set to 6h → fresh
  // 5h-old signal should NOT trip), and would over-fire on tenants
  // that TIGHTENED (set to 2h → 3h-old signal SHOULD trip but a 4h
  // platform-default cutoff misses it).
  //
  // Implementation: fetch candidates with the LOOSEST possible cutoff
  // (the upper-bound of `BOUNDS.staleThresholdHours.max = 168`) so
  // any tenant's possible threshold is in scope, then per-tenant
  // filter on the resolved threshold. The upper bound is small
  // enough (1 week) that this doesn't fan out unboundedly — and the
  // existing acked/fresh SQL predicates still exclude the bulk of
  // rows.
  const { resolveCronThresholds, BOUNDS } = await import(
    "@/lib/cron-thresholds/resolve"
  );
  const upperBoundHours = BOUNDS.staleThresholdHours.max;
  const upperBoundCutoff = new Date(
    now.getTime() - upperBoundHours * 60 * 60 * 1000,
  );
  // Lower-bound cutoff (strictest tenant) — anything fresher than
  // BOUNDS.min has no chance of tripping in any tenant.
  const lowerBoundHours = BOUNDS.staleThresholdHours.min;
  const candidateCutoff = new Date(
    now.getTime() - lowerBoundHours * 60 * 60 * 1000,
  );

  // Candidate query: escalated, not acknowledged, escalated before
  // the strictest possible cutoff. SQL predicates do all the
  // first-pass filtering — we don't fetch acknowledged-or-fresh
  // signals only to skip them in-app.
  void upperBoundCutoff; // upper-bound is informational; lower-bound is the SQL predicate
  const allCandidates = await superDb.sentimentSignal.findMany({
    where: {
      ...(opts?.tenantId ? { tenantId: opts.tenantId } : {}),
      escalatedAt: { not: null, lt: candidateCutoff },
      acknowledgedAt: null,
    },
    include: {
      tenant: { select: { slug: true } },
      ingestedMessage: { select: { sender: true } },
    },
  });

  // Per-tenant resolve + filter. Cache the resolved thresholds so a
  // tenant with N candidate signals isn't queried N times.
  const tenantThresholdCache = new Map<string, number>();
  async function getTenantStaleThresholdHours(tenantId: string): Promise<number> {
    const cached = tenantThresholdCache.get(tenantId);
    if (cached !== undefined) return cached;
    const t = await resolveCronThresholds(tenantId);
    tenantThresholdCache.set(tenantId, t.staleThresholdHours);
    return t.staleThresholdHours;
  }
  const candidates: typeof allCandidates = [];
  for (const c of allCandidates) {
    if (!c.escalatedAt) continue;
    const tenantHours = await getTenantStaleThresholdHours(c.tenantId);
    const ageMs = now.getTime() - c.escalatedAt.getTime();
    if (ageMs >= tenantHours * 60 * 60 * 1000) {
      candidates.push(c);
    }
  }

  const result: SentimentStaleSweepResult = {
    scanned: candidates.length,
    warned: 0,
    alreadyWarned: 0,
    skipped: 0,
    errored: 0,
  };

  for (const signal of candidates) {
    try {
      if (!signal.escalatedAt) {
        // The SQL predicate filtered nulls; TS can't see that.
        result.skipped += 1;
        continue;
      }

      // Dedup at the audit-chain level. We could probe a dispatch row
      // instead (item 71's pattern), but the audit chain is the
      // authoritative "we noticed this" record and the chain query is
      // O(1) per signal via the indexed subject lookup.
      const existing = await superDb.auditEvent.findFirst({
        where: {
          tenantId: signal.tenantId,
          eventType: "SENTIMENT_ESCALATION_STALE_WARNED",
          subjectType: "SentimentSignal",
          subjectId: signal.id,
        },
        select: { id: true },
      });
      if (existing) {
        result.alreadyWarned += 1;
        continue;
      }

      const hoursSinceEscalation =
        (now.getTime() - signal.escalatedAt.getTime()) / (60 * 60 * 1000);

      // Audit FIRST. If the dispatch fan-out subsequently fails or is
      // partial, the chain still records that the cron tripped on this
      // signal. Mirrors item 71's "page is canonical truth source"
      // posture.
      await writeAuditEvent({
        tenantId: signal.tenantId,
        eventType: "SENTIMENT_ESCALATION_STALE_WARNED",
        actorMembershipId: null,
        subjectType: "SentimentSignal",
        subjectId: signal.id,
        payload: {
          signalId: signal.id,
          escalatedAt: signal.escalatedAt.toISOString(),
          hoursSinceEscalation: Math.round(hoursSinceEscalation * 10) / 10,
          classification: signal.classification,
          // Per-tenant resolved value (item 100). The cache populated above
          // is per-tenant so this is one more lookup, no DB hit.
          thresholdHours: await getTenantStaleThresholdHours(signal.tenantId),
        },
      });

      const { recipients } = await dispatchSentimentEscalationStale({
        tenantId: signal.tenantId,
        tenantSlug: signal.tenant.slug,
        signalId: signal.id,
        assignedToMembershipId: signal.assignedToMembershipId,
        hoursSinceEscalation,
        trigger: signal.trigger,
        inboundSender: signal.ingestedMessage?.sender ?? null,
      });

      // No-recipients case (zero ACTIVE FCT/FIRM_ADMIN, assigned User
      // anonymised) — count as "warned" because the audit row is the
      // load-bearing record. Same call as item 71's "no_data" handling.
      void recipients;

      result.warned += 1;
    } catch (err) {
      reportError(
        err,
        {
          route: "lib/sentiment/stale-sweep",
          tenantId: signal.tenantId,
          extra: { signalId: signal.id },
        },
        "sentiment-stale sweep dispatch failed",
      );
      result.errored += 1;
    }
  }

  return result;
}
