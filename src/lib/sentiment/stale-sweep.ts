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
  const cutoff = new Date(now.getTime() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000);

  // Candidate query: escalated, not acknowledged, escalated before the
  // stale cutoff. SQL predicates do all the filtering — we don't
  // fetch acknowledged-or-fresh signals only to skip them in-app.
  const candidates = await superDb.sentimentSignal.findMany({
    where: {
      ...(opts?.tenantId ? { tenantId: opts.tenantId } : {}),
      escalatedAt: { not: null, lt: cutoff },
      acknowledgedAt: null,
    },
    include: {
      tenant: { select: { slug: true } },
      ingestedMessage: { select: { sender: true } },
    },
  });

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
          thresholdHours: STALE_THRESHOLD_HOURS,
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
