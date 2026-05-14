import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchAdherenceEscalationStale } from "@/lib/notifications/immediate";
import { reportError } from "@/lib/observability";

/**
 * Post-PRD hardening item 99 — stale-adherence-escalation sweeper.
 *
 * Adherence-pillar analog of item 77's sentiment-stale sweep. Backlog
 * item 1 routes a below-threshold send through `escalateAdherenceIfPoor`,
 * which fires the mandatory `adherence_escalation` notification at the
 * moment of the trip. If nobody acknowledges within
 * `STALE_THRESHOLD_HOURS`, the FCG/UCG-violating send sits as an open
 * audit-trail gap — exactly the kind of silent failure this engine
 * exists to surface. This sweep is the second-chance nudge.
 *
 * Mirrors item 77's shape with one adherence-pillar difference:
 *   - Recipients use `membershipId` (the SENDER of the bad send) for the
 *     self-recipient seed, NOT `assignedToMembershipId`. Sentiment
 *     escalates an inbound to its assignee; adherence escalates the
 *     SEND to its sender. Both `dispatchAdherenceEscalation` (item 1)
 *     and the `<NavBadges>` adherence stale-tone (item 94) use this
 *     same field — pillar-wide invariant.
 *
 * Skip conditions (all SQL predicates — bytes we'd only drop in-app
 * aren't fetched):
 *   - `escalatedAt` is null — never tripped, nothing to nudge.
 *   - `escalatedAt` is more recent than `STALE_THRESHOLD_HOURS` ago —
 *     not yet stale.
 *   - `acknowledgedAt` is non-null — already actioned.
 *   - Audit chain already has an `ADHERENCE_ESCALATION_STALE_WARNED`
 *     row for this row — already nudged in a prior cron tick.
 *
 * Notification kind `adherence_escalation_stale` is mandatory (NOT in
 * `OPT_OUTABLE_KINDS`). The unacknowledged compliance escalation IS
 * the audit-trail gap this engine exists to close; muting the nudge
 * defeats governance — same posture as item 77 on the sentiment side.
 *
 * Audit event `ADHERENCE_ESCALATION_STALE_WARNED` lands on the tenant
 * chain. Audit FIRST, then fan out — mirrors items 71 / 77 / 84 / 95:
 * the chain reflects the trip even if every recipient dispatch fails
 * (the cron noticed; that's the load-bearing fact).
 *
 * `STALE_THRESHOLD_HOURS` shared with item 77's sentiment sweep AND
 * with item 94's `<NavBadges>` stale-tone + per-row `<LiveOutstanding>`
 * red-text boundary. Operator mental model is "4h = bad" everywhere on
 * both pillars; reading any of those surfaces should match what this
 * cron will trip on. A future per-tenant override would change all
 * three together.
 */

export const STALE_THRESHOLD_HOURS = 4;

export type AdherenceStaleSweepResult = {
  /// Escalated-and-unacked rows returned by the candidate query.
  scanned: number;
  /// First-time stale nudges dispatched this pass.
  warned: number;
  /// Audit chain already has a stale-warned row for this adherence row —
  /// counted but not re-actioned. Steady-state line on every tick.
  alreadyWarned: number;
  /// Skipped for any documented reason above.
  skipped: number;
  /// Persist / dispatch threw. Logged via reportError; sweep continues.
  errored: number;
};

export async function runAdherenceStaleSweep(opts?: {
  /** Override "now" — tests pin a deterministic clock. */
  now?: Date;
  /** Restrict to a single tenant — tests / on-demand. */
  tenantId?: string;
}): Promise<AdherenceStaleSweepResult> {
  const now = opts?.now ?? new Date();

  // Item 100 — per-tenant override on `staleThresholdHours`. Same
  // two-pass shape as item 100's update to the sentiment-stale
  // sweep: SQL filter at BOUNDS.min (strictest possible cutoff) so
  // we can't miss a tenant who tightened, then per-tenant filter on
  // the resolved threshold so a loosened tenant doesn't over-fire.
  const { resolveCronThresholds, BOUNDS } = await import(
    "@/lib/cron-thresholds/resolve"
  );
  const lowerBoundHours = BOUNDS.staleThresholdHours.min;
  const candidateCutoff = new Date(
    now.getTime() - lowerBoundHours * 60 * 60 * 1000,
  );

  // Candidate query: escalated, not acknowledged, escalated before the
  // strictest possible cutoff.
  const allCandidates = await superDb.communicationAdherence.findMany({
    where: {
      ...(opts?.tenantId ? { tenantId: opts.tenantId } : {}),
      escalatedAt: { not: null, lt: candidateCutoff },
      acknowledgedAt: null,
    },
    include: {
      tenant: { select: { slug: true } },
    },
  });

  // Per-tenant resolve + filter. Cache the resolved thresholds so a
  // tenant with N candidate rows isn't queried N times.
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

  const result: AdherenceStaleSweepResult = {
    scanned: candidates.length,
    warned: 0,
    alreadyWarned: 0,
    skipped: 0,
    errored: 0,
  };

  for (const row of candidates) {
    try {
      if (!row.escalatedAt) {
        // The SQL predicate filtered nulls; TS can't see that.
        result.skipped += 1;
        continue;
      }

      // Dedup at the audit-chain level. We could probe a dispatch row
      // instead (item 71's pattern), but the audit chain is the
      // authoritative "we noticed this" record and the chain query is
      // O(1) per row via the indexed subject lookup. Same posture as
      // item 77's sister sweep.
      const existing = await superDb.auditEvent.findFirst({
        where: {
          tenantId: row.tenantId,
          eventType: "ADHERENCE_ESCALATION_STALE_WARNED",
          subjectType: "CommunicationAdherence",
          subjectId: row.id,
        },
        select: { id: true },
      });
      if (existing) {
        result.alreadyWarned += 1;
        continue;
      }

      const hoursSinceEscalation =
        (now.getTime() - row.escalatedAt.getTime()) / (60 * 60 * 1000);

      // Audit FIRST. If the dispatch fan-out subsequently fails or is
      // partial, the chain still records that the cron tripped on this
      // row. Mirrors items 71 / 77 / 84 / 95 — page is the canonical
      // truth source; chain row is "we noticed and tried to tell
      // people" record.
      await writeAuditEvent({
        tenantId: row.tenantId,
        eventType: "ADHERENCE_ESCALATION_STALE_WARNED",
        actorMembershipId: null,
        subjectType: "CommunicationAdherence",
        subjectId: row.id,
        payload: {
          adherenceId: row.id,
          draftId: row.draftId,
          membershipId: row.membershipId,
          escalatedAt: row.escalatedAt.toISOString(),
          hoursSinceEscalation: Math.round(hoursSinceEscalation * 10) / 10,
          overall: row.overall,
          // Per-tenant resolved value (item 100). Cache populated above is
          // per-tenant so this is one more lookup, no DB hit.
          thresholdHours: await getTenantStaleThresholdHours(row.tenantId),
        },
      });

      const { recipients } = await dispatchAdherenceEscalationStale({
        tenantId: row.tenantId,
        tenantSlug: row.tenant.slug,
        adherenceId: row.id,
        draftId: row.draftId,
        membershipId: row.membershipId,
        hoursSinceEscalation,
        overall: row.overall,
      });

      // No-recipients case (zero ACTIVE FCT/FIRM_ADMIN, sender
      // membership anonymised) — count as "warned" because the audit
      // row is the load-bearing record. Same call as item 77.
      void recipients;

      result.warned += 1;
    } catch (err) {
      reportError(
        err,
        {
          route: "lib/adherence/stale-sweep",
          tenantId: row.tenantId,
          extra: { adherenceId: row.id },
        },
        "adherence-stale sweep dispatch failed",
      );
      result.errored += 1;
    }
  }

  return result;
}
