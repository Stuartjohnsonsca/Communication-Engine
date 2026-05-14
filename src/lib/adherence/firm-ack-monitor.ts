import { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { isoWeekKey } from "@/lib/notifications/digest";
import { reportError } from "@/lib/observability";
import { formatDurationOrDash } from "@/lib/format/duration";
import { computeAdherenceMetrics } from "./metrics";

/**
 * Post-PRD hardening item 95 — low ack-rate firm-wide escalation alert
 * on the ADHERENCE pillar.
 *
 * Sister to item 84's `firm-ack-monitor` (sentiment pillar) and the
 * adherence-pillar's existing item 71 firm-adherence monitor (which
 * measures FCG-window compliance — a different question entirely).
 * Items 89–94 surfaced adherence-escalation response-time observability
 * (CSV export, card, trend pills, per-Member breakdown, /account
 * self-view, near-live UI). All require operators to actively visit
 * /adherence/escalations. This worker closes the gap: when a tenant's
 * 7d ack rate on below-threshold-send escalations falls below
 * `ACK_RATE_THRESHOLD` with a meaningful volume of escalated rows,
 * every active FIRM_ADMIN gets pushed an email + in-app notification.
 *
 * **Adherence-pillar firm-wide alerts now answer TWO distinct questions**:
 *   - `firm_adherence_below_threshold` (item 71):
 *     "Are you replying to clients within the FCG promise window?"
 *   - `firm_adherence_ack_rate_below_threshold` (item 95, THIS file):
 *     "When a send DID breach compliance, are you acknowledging the
 *      escalation?"
 *
 * The two are independent: a tenant can be fast at replying within
 * window AND slow at acknowledging the rare below-threshold
 * escalations, tripping item 95 without tripping item 71. Or vice
 * versa: slow window adherence with diligent ack-rate on the few
 * that do escalate. Both signals matter, neither subsumes the other.
 *
 * **Volume floor (`MIN_ESCALATED_FOR_ALERT`)** is load-bearing — see
 * item 84's docstring. The floor is 5, matching `MIN_SIGNALS_FLOOR`
 * from item 92 (per-Member adherence) and item 80 (sentiment).
 * Without it a tenant with 1 escalated + 0 acked (0%) trips and
 * trains operators to dismiss the alert.
 *
 * **No-data short-circuit**: tenants with `escalated === 0` skip — no
 * escalations means no ack-rate to measure, same invariant as items
 * 66 / 69 / 78 / 90 (null-when-no-data, never fake a 0/0 alert).
 *
 * **Dedupe is per ISO week.** dedupeKey is
 * `firm-adherence-ack-below:<isoWeek>` — distinct from item 71's
 * `firm-adherence-below:<isoWeek>` so the two adherence-side firm
 * alerts have independent fire/dedupe state. A tenant tripping both
 * in the same week gets TWO emails (one per question), matching the
 * separation of concerns.
 *
 * **Audit lands on the affected tenant's chain** and **fires FIRST
 * before fan-out** — same invariants as items 71 / 84. The chain
 * reflects the trip even if every recipient dispatch fails.
 *
 * **FIRM_ADMIN-only recipients**: USER, FCT_MEMBER, SALES_REVIEWER
 * memberships don't receive the firm-wide alert. The FCT already
 * sees every individual escalation in real time via the existing
 * adherence-escalation dispatch; a weekly rollup specifically to
 * FIRM_ADMIN matches items 71 / 84's accountability shape.
 *
 * Skip conditions returned in the result (observability, not errors):
 *   - tenant has no escalated rows in window (`no_data`)
 *   - tenant has fewer than `MIN_ESCALATED_FOR_ALERT` escalated rows
 *     (`skipped_low_volume`)
 *   - tenant's `acknowledgedRate >= ACK_RATE_THRESHOLD`
 *     (`above_threshold`)
 *   - dispatch row already exists for this (tenant, ISO week)
 *     (`already_alerted_this_week`)
 */

/// 7-day rolling window. Matches items 71 + 84 so all three firm-wide
/// governance alerts share a cadence — a FIRM_ADMIN reading three
/// different "this week" definitions across crons would be operationally
/// confusing.
export const WINDOW_DAYS = 7;

/// Below this rate trips the alert. 0.75 = "we're acknowledging fewer
/// than 3 in 4 escalated below-threshold sends over the week." Picked
/// to MATCH item 84's sentiment ack-rate threshold so the operator's
/// mental model is "75% ack rate = the line" across both pillars.
/// Looser than item 71's 0.80 FCG-window threshold because ack-rate is
/// a softer metric than the FCG promise itself — same reasoning as
/// item 84. A future per-tenant override can move this without code
/// change.
export const ACK_RATE_THRESHOLD = 0.75;

/// Minimum escalated-row volume to consider the rate meaningful.
/// Matches item 84's `MIN_ESCALATED_FOR_ALERT` and item 92's
/// `MIN_SIGNALS_FLOOR`. Below this, the rate is too noisy for a
/// weekly governance alert — a tenant with 2 escalated + 1 acked is
/// 50%, which would falsely flag a low-traffic week.
export const MIN_ESCALATED_FOR_ALERT = 5;

export type FirmAdherenceAckMonitorOutcome =
  | { result: "no_data" }
  | { result: "skipped_low_volume"; escalated: number }
  | {
      result: "above_threshold";
      escalated: number;
      acknowledgedRate: number;
    }
  | { result: "already_alerted_this_week"; isoWeek: string }
  | {
      result: "alerted";
      isoWeek: string;
      escalated: number;
      acknowledged: number;
      acknowledgedRate: number;
      medianAckMs: number | null;
      oldestUnackedMs: number | null;
      notifiedMembershipIds: string[];
    };

export type FirmAdherenceAckMonitorRunResult = {
  scanned: number;
  alerted: number;
  alreadyAlerted: number;
  skipped: number;
  errored: number;
  perTenant: Array<{
    tenantId: string;
    outcome: FirmAdherenceAckMonitorOutcome;
  }>;
};

/**
 * Evaluate one tenant. Pure function over the adherence metrics +
 * dispatch table; the cron caller is just a fan-out + error-isolation
 * wrapper. Mirrors `evaluateTenantFirmAckRate` (item 84) on the
 * sentiment side and `evaluateTenantAdherence` (item 71) on the
 * FCG-window side.
 */
export async function evaluateTenantFirmAdherenceAckRate(input: {
  tenantId: string;
  now?: Date;
}): Promise<FirmAdherenceAckMonitorOutcome> {
  const now = input.now ?? new Date();
  const isoWeek = isoWeekKey(now);

  // Reuse `computeAdherenceMetrics` so this can't drift from the
  // /adherence/escalations response-time card (items 90 / 91). Same
  // window, same classifier, same null-when-no-data invariant. No
  // `withByMember` — the firm-wide rate is the only field we read.
  const metrics = await computeAdherenceMetrics({
    tenantId: input.tenantId,
    windowDays: WINDOW_DAYS,
    now,
  });

  const {
    escalated,
    acknowledged,
    acknowledgedRate,
    medianAckMs,
    oldestUnackedMs,
  } = metrics;

  // No escalations in window — no ack-rate to measure. Same invariant
  // as items 66 / 69 / 78 / 90: null/zero denominator never fakes an
  // alert.
  if (escalated === 0 || acknowledgedRate === null) {
    return { result: "no_data" };
  }

  // Volume floor — small denominators don't get to fire the alert.
  if (escalated < MIN_ESCALATED_FOR_ALERT) {
    return { result: "skipped_low_volume", escalated };
  }

  if (acknowledgedRate >= ACK_RATE_THRESHOLD) {
    return { result: "above_threshold", escalated, acknowledgedRate };
  }

  // Below threshold + above volume floor → trip the alert. Note the
  // dedupeKey namespace prefix `firm-adherence-ack-below:` is distinct
  // from item 71's `firm-adherence-below:` so the two adherence-side
  // firm alerts have independent fire/dedupe state. A tenant tripping
  // both in the same week gets two emails.
  const dedupeKey = `firm-adherence-ack-below:${isoWeek}`;

  const tenant = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: { name: true, slug: true },
  });
  if (!tenant) {
    return { result: "no_data" };
  }

  const admins = await superDb.membership.findMany({
    where: {
      tenantId: input.tenantId,
      role: "FIRM_ADMIN",
      status: "ACTIVE",
    },
    include: { user: { select: { email: true } } },
  });

  if (admins.length === 0) {
    // No FIRM_ADMIN to notify. Audit nothing — no governance recipient
    // means no governance outcome to record. /adherence/escalations
    // still shows the rate in the UI.
    return { result: "no_data" };
  }

  // Probe the first admin's dispatch row to skip the audit + fan-out
  // when already alerted. Same idempotency trick as items 71 / 84 —
  // if a new FIRM_ADMIN joins mid-week they still receive their first
  // notification via the per-membership loop below
  // (`dispatchNotification` is idempotent per recipient).
  const probe = await superDb.notificationDispatch.findUnique({
    where: {
      membershipId_kind_dedupeKey: {
        membershipId: admins[0].id,
        kind: "firm_adherence_ack_rate_below_threshold",
        dedupeKey,
      },
    },
  });
  if (probe) {
    return { result: "already_alerted_this_week", isoWeek };
  }

  const pct = Math.round(acknowledgedRate * 100);
  const threshPct = Math.round(ACK_RATE_THRESHOLD * 100);
  const subject = `[${tenant.name}] Adherence ack rate below ${threshPct}% (${pct}% over ${WINDOW_DAYS}d)`;
  const medianLabel = formatDurationOrDash(medianAckMs);
  const oldestLabel = formatDurationOrDash(oldestUnackedMs);
  // Phrasing deliberately distinguishes this from item 71's body
  // ("you are missing the FCG response window") — both could land in
  // the same FIRM_ADMIN inbox in the same week and the operator must
  // immediately recognise which question is being raised. "Compliance
  // escalations" + "below-threshold sends" makes the scope explicit.
  const text =
    `The firm's adherence-escalation acknowledgement rate over the last ${WINDOW_DAYS} days is ${pct}%, ` +
    `below the ${threshPct}% threshold.\n\n` +
    `Below-threshold sends escalated in window: ${escalated}\n` +
    `Acknowledged: ${acknowledged}\n` +
    `Median time-to-acknowledge: ${medianLabel}\n` +
    `Oldest still-unacked: ${oldestLabel}\n\n` +
    `This is distinct from the FCG-window adherence alert: this one fires when escalated compliance ` +
    `flags on already-sent communications are being left unacknowledged. Open /adherence/escalations ` +
    `for the full list. Every escalation represents a send that scored below the compliance gate; the ` +
    `acknowledgement is the audit-trail record that the firm has reviewed and accepted the finding. ` +
    `One alert per week — escalation will not re-fire until next ISO week even if the rate stays ` +
    `below threshold.`;

  const auditPayload: Prisma.InputJsonValue = {
    windowDays: WINDOW_DAYS,
    escalated,
    acknowledged,
    acknowledgedRate,
    medianAckMs,
    oldestUnackedMs,
    threshold: ACK_RATE_THRESHOLD,
    minEscalated: MIN_ESCALATED_FOR_ALERT,
    isoWeek,
  };

  // Audit FIRST so the chain reflects the trip even if every recipient
  // dispatch fails — same invariant as items 71 / 84.
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "FIRM_ADHERENCE_ACK_RATE_BELOW_THRESHOLD",
    actorMembershipId: null,
    subjectType: "Tenant",
    subjectId: input.tenantId,
    payload: auditPayload,
  });

  const notifiedMembershipIds: string[] = [];
  for (const m of admins) {
    if (!m.user.email) continue;
    try {
      await dispatchNotification({
        tenantId: input.tenantId,
        membershipId: m.id,
        toEmail: m.user.email,
        kind: "firm_adherence_ack_rate_below_threshold",
        dedupeKey,
        subject,
        text,
        summary: `Adherence ack rate ${pct}% over ${WINDOW_DAYS}d (threshold ${threshPct}%)`,
        // Tenant-scoped href — opens the /adherence/escalations page
        // for this tenant, where the operator can act on the open
        // rows feeding the rate.
        href: `/${tenant.slug}/adherence/escalations`,
        payload: auditPayload,
      });
      notifiedMembershipIds.push(m.id);
    } catch (err) {
      reportError(
        err,
        {
          route: "lib/adherence/firm-ack-monitor",
          tenantId: input.tenantId,
          membershipId: m.id,
        },
        "firm-adherence-ack escalation notification dispatch failed",
      );
    }
  }

  return {
    result: "alerted",
    isoWeek,
    escalated,
    acknowledged,
    acknowledgedRate,
    medianAckMs,
    oldestUnackedMs,
    notifiedMembershipIds,
  };
}

/**
 * Cron entry point. Iterates every tenant and evaluates them in
 * isolation — one tenant's failure doesn't abort the pass. Mirrors
 * `runFirmAckMonitor` (item 84) and `runAdherenceMonitor` (item 71).
 */
export async function runFirmAdherenceAckMonitor(opts?: {
  now?: Date;
  tenantId?: string;
}): Promise<FirmAdherenceAckMonitorRunResult> {
  const tenants = await superDb.tenant.findMany({
    where: opts?.tenantId ? { id: opts.tenantId } : undefined,
    select: { id: true },
  });

  const result: FirmAdherenceAckMonitorRunResult = {
    scanned: tenants.length,
    alerted: 0,
    alreadyAlerted: 0,
    skipped: 0,
    errored: 0,
    perTenant: [],
  };

  for (const t of tenants) {
    try {
      const outcome = await evaluateTenantFirmAdherenceAckRate({
        tenantId: t.id,
        now: opts?.now,
      });
      result.perTenant.push({ tenantId: t.id, outcome });
      switch (outcome.result) {
        case "alerted":
          result.alerted += 1;
          break;
        case "already_alerted_this_week":
          result.alreadyAlerted += 1;
          break;
        case "above_threshold":
        case "skipped_low_volume":
        case "no_data":
          result.skipped += 1;
          break;
      }
    } catch (err) {
      reportError(
        err,
        {
          route: "lib/adherence/firm-ack-monitor",
          tenantId: t.id,
        },
        "firm-adherence-ack monitor tenant evaluation failed",
      );
      result.errored += 1;
    }
  }

  return result;
}
