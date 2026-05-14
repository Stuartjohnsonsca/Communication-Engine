import { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { isoWeekKey } from "@/lib/notifications/digest";
import { reportError } from "@/lib/observability";
import { computeSentimentMetrics, formatTtaDuration } from "./metrics";

/**
 * Post-PRD hardening item 84 — low ack-rate firm-wide escalation alert.
 *
 * Sister to item 71's `adherence-monitor` on the sentiment side. Items
 * 77–83 surfaced sentiment response-time observability (per-signal stale
 * nudge, page card, trend pills, per-Member breakdown, /account self-view,
 * near-live UI, CSV export). They all rely on operators actively visiting
 * /sentiment. This worker closes the gap: when a tenant's 7d ack rate
 * falls below `ACK_RATE_THRESHOLD` with a meaningful volume of escalated
 * signals, every active FIRM_ADMIN gets pushed an email + in-app inbox
 * notification. Acknowledging escalated counterparty complaints IS the
 * firm's response posture to PRD §9.3; silently failing on it is
 * exactly the gap this engine exists to prevent.
 *
 * **Volume floor (`MIN_ESCALATED_FOR_ALERT`)** is load-bearing. Without
 * it a tenant with 1 escalated + 0 acked (0%) trips the alert and trains
 * operators to dismiss it. The floor is 5 — lower than item 71's 10
 * because sentiment volumes per tenant are lower than draft volumes
 * (matches `MIN_SIGNALS_FLOOR = 5` from item 80; the "small but
 * non-trivial" data-quality threshold the sentiment pillar already
 * settled on). Tenants below the floor return
 * `result: "skipped_low_volume"` and silently pass.
 *
 * **No-data short-circuit**: tenants with `escalated === 0` skip — no
 * escalations means no ack-rate to measure, same invariant as items
 * 66/69/78 (null-when-no-data, never fake a 0/0 alert).
 *
 * **Dedupe is per ISO week.** A tenant chronically below threshold gets
 * one alert per Monday-to-Sunday window. dedupeKey is
 * `firm-sentiment-ack-below:<isoWeek>` so a daily cron run is a no-op
 * after the first trip in any given week. Mirrors item 71's pattern
 * exactly — operators get one shape of weekly-bucket firm-wide alert
 * across all of governance.
 *
 * **Audit lands on the affected tenant's chain** — same rule as item
 * 71. A FIRM_ADMIN reading their own audit log sees "we got flagged
 * for low sentiment ack rate on 2026-W19" as a stable record.
 *
 * **Audit FIRST, then fan out**: the chain reflects the trip even if
 * every recipient dispatch fails. The /sentiment page is canonical
 * truth source; this row is the "we noticed and tried to tell people"
 * record.
 *
 * **FIRM_ADMIN-only recipients**: USER, FCT_MEMBER, SALES_REVIEWER
 * memberships don't receive the firm-wide alert. The FCT already sees
 * every escalation in real time via the existing sentiment_escalation
 * dispatch (PRD §9.3) and on /sentiment; a weekly rollup specifically
 * to FIRM_ADMIN matches item 71's accountability shape (the FIRM_ADMIN
 * is the responsible operator for firm-wide governance metrics).
 *
 * Skip conditions returned in the result (for observability, not as
 * errors):
 *   - tenant has no escalated signals in window (`no_data`)
 *   - tenant has fewer than `MIN_ESCALATED_FOR_ALERT` escalated signals
 *     (`skipped_low_volume`)
 *   - tenant's `acknowledgedRate >= ACK_RATE_THRESHOLD`
 *     (`above_threshold`)
 *   - dispatch row already exists for this (tenant, ISO week)
 *     (`already_alerted_this_week`)
 */

/// 7-day rolling window. Matches item 71's `WINDOW_DAYS` so the two
/// firm-wide governance alerts share a cadence — a FIRM_ADMIN looking
/// at a weekly window for adherence and a different one for ack rate
/// would have to reconcile two different "this week" definitions.
export const WINDOW_DAYS = 7;

/// Below this rate trips the alert. 0.75 = "we're acknowledging fewer
/// than 3 in 4 escalated counterparty complaints over the week." Picked
/// looser than item 71's adherence threshold (0.80) because ack-rate is
/// a softer metric than FCG-window adherence — an escalation might
/// resolve without an explicit "ack" click if the User responds inline
/// to the draft. Tightening to 0.80 here would over-fire on tenants
/// who run sentiment through the workflow without rigorously
/// click-acking. A future per-tenant override can move this without
/// code change.
export const ACK_RATE_THRESHOLD = 0.75;

/// Minimum escalated-signal volume to consider the rate meaningful.
/// Matches `MIN_SIGNALS_FLOOR = 5` from item 80 — the sentiment
/// pillar's existing "small but non-trivial" threshold. Below this,
/// the rate is too noisy for a weekly governance alert (a tenant
/// with 2 escalated + 1 acked is 50%, which would falsely flag a
/// low-traffic week).
export const MIN_ESCALATED_FOR_ALERT = 5;

export type FirmAckMonitorOutcome =
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

export type FirmAckMonitorRunResult = {
  /// Tenants inspected this pass.
  scanned: number;
  /// First-time alerts dispatched this pass (across all tenants).
  alerted: number;
  /// Dispatch row already existed for (tenant, this week) — counted but
  /// not re-actioned. Steady state on a daily cron after the first trip.
  alreadyAlerted: number;
  /// Tenants below volume floor or above threshold — no alert needed.
  skipped: number;
  /// Tenant scan threw. Logged via `reportError`; cron does not abort
  /// on a single tenant's failure.
  errored: number;
  /// Per-tenant outcome for observability + tests.
  perTenant: Array<{ tenantId: string; outcome: FirmAckMonitorOutcome }>;
};

/**
 * Evaluate one tenant. Pure function over the sentiment metrics +
 * dispatch table; the cron caller is just a fan-out + error-isolation
 * wrapper. Mirrors `evaluateTenantAdherence` (item 71).
 */
export async function evaluateTenantFirmAckRate(input: {
  tenantId: string;
  now?: Date;
}): Promise<FirmAckMonitorOutcome> {
  const now = input.now ?? new Date();
  const isoWeek = isoWeekKey(now);

  // Item 100 — per-tenant override resolver. Constants in this file
  // remain the platform defaults; tenants with a row override one or
  // both knobs.
  const { resolveCronThresholds } = await import("@/lib/cron-thresholds/resolve");
  const thresholds = await resolveCronThresholds(input.tenantId);
  const ackRateThreshold = thresholds.ackRateThreshold;
  const minEscalatedForAlert = thresholds.minEscalatedForAlert;

  // Reuse `computeSentimentMetrics` so this can't drift from the
  // /sentiment page's response-time card (items 78/79). Same window,
  // same classifier, same null-when-no-data invariant. No `withByMember`
  // — the firm-wide rate is the only field we read.
  const metrics = await computeSentimentMetrics({
    tenantId: input.tenantId,
    windowDays: WINDOW_DAYS,
    now,
  });

  const { escalated, acknowledged, acknowledgedRate, medianAckMs, oldestUnackedMs } =
    metrics;

  // No escalations in window — no ack-rate to measure. Same invariant
  // as items 66/69/78: null/zero denominator never fakes an alert.
  if (escalated === 0 || acknowledgedRate === null) {
    return { result: "no_data" };
  }

  // Volume floor — small denominators don't get to fire the alert.
  if (escalated < minEscalatedForAlert) {
    return { result: "skipped_low_volume", escalated };
  }

  if (acknowledgedRate >= ackRateThreshold) {
    return { result: "above_threshold", escalated, acknowledgedRate };
  }

  // Below threshold + above volume floor → trip the alert.
  const dedupeKey = `firm-sentiment-ack-below:${isoWeek}`;

  const tenant = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: { name: true, slug: true },
  });
  if (!tenant) {
    return { result: "no_data" };
  }

  const admins = await superDb.membership.findMany({
    where: { tenantId: input.tenantId, role: "FIRM_ADMIN", status: "ACTIVE" },
    include: { user: { select: { email: true } } },
  });

  if (admins.length === 0) {
    // No FIRM_ADMIN to notify. Audit nothing — no governance recipient
    // means no governance outcome to record. /sentiment still shows
    // the rate in the UI.
    return { result: "no_data" };
  }

  // Probe the first admin's dispatch row to skip the audit + fan-out
  // when already alerted. Same idempotency trick as item 71 — if a
  // new FIRM_ADMIN joins mid-week they still receive their first
  // notification via the per-membership loop below
  // (`dispatchNotification` is idempotent per recipient).
  const probe = await superDb.notificationDispatch.findUnique({
    where: {
      membershipId_kind_dedupeKey: {
        membershipId: admins[0].id,
        kind: "firm_sentiment_ack_rate_below_threshold",
        dedupeKey,
      },
    },
  });
  if (probe) {
    return { result: "already_alerted_this_week", isoWeek };
  }

  const pct = Math.round(acknowledgedRate * 100);
  const threshPct = Math.round(ackRateThreshold * 100);
  const subject = `[${tenant.name}] Sentiment ack rate below ${threshPct}% (${pct}% over ${WINDOW_DAYS}d)`;
  const medianLabel = formatTtaDuration(medianAckMs);
  const oldestLabel = formatTtaDuration(oldestUnackedMs);
  const text =
    `The firm's sentiment-escalation acknowledgement rate over the last ${WINDOW_DAYS} days is ${pct}%, ` +
    `below the ${threshPct}% threshold.\n\n` +
    `Escalated signals in window: ${escalated}\n` +
    `Acknowledged: ${acknowledged}\n` +
    `Median time-to-acknowledge: ${medianLabel}\n` +
    `Oldest still-unacked: ${oldestLabel}\n\n` +
    `Open /sentiment for the full list. Every PRD §9.3 escalation represents a counterparty signal that ` +
    `we promised to action; this alert means the firm is leaving more than one in four of them ` +
    `unacknowledged over the week. One alert per week — escalation will not re-fire until next ISO ` +
    `week even if the rate stays below threshold.`;

  const auditPayload: Prisma.InputJsonValue = {
    windowDays: WINDOW_DAYS,
    escalated,
    acknowledged,
    acknowledgedRate,
    medianAckMs,
    oldestUnackedMs,
    threshold: ackRateThreshold,
    minEscalated: minEscalatedForAlert,
    isoWeek,
  };

  // Audit FIRST so the chain reflects the trip even if every recipient
  // dispatch fails — same invariant as item 71.
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "FIRM_SENTIMENT_ACK_RATE_BELOW_THRESHOLD",
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
        kind: "firm_sentiment_ack_rate_below_threshold",
        dedupeKey,
        subject,
        text,
        summary: `Sentiment ack rate ${pct}% over ${WINDOW_DAYS}d (threshold ${threshPct}%)`,
        // Tenant-scoped path — `/${tenantSlug}/sentiment` matches the
        // immediate sentiment dispatchers (see `dispatchSentimentEscalation`
        // in src/lib/notifications/immediate.ts). The inbox card will
        // open the /sentiment page for this exact tenant.
        href: `/${tenant.slug}/sentiment`,
        payload: auditPayload,
      });
      notifiedMembershipIds.push(m.id);
    } catch (err) {
      reportError(
        err,
        {
          route: "lib/sentiment/firm-ack-monitor",
          tenantId: input.tenantId,
          membershipId: m.id,
        },
        "firm-sentiment-ack escalation notification dispatch failed",
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
 * `runAdherenceMonitor` (item 71).
 */
export async function runFirmAckMonitor(opts?: {
  /** Override "now" — tests pin a deterministic clock. */
  now?: Date;
  /** Restrict to a single tenant — tests / on-demand. */
  tenantId?: string;
}): Promise<FirmAckMonitorRunResult> {
  const tenants = await superDb.tenant.findMany({
    where: opts?.tenantId ? { id: opts.tenantId } : undefined,
    select: { id: true },
  });

  const result: FirmAckMonitorRunResult = {
    scanned: tenants.length,
    alerted: 0,
    alreadyAlerted: 0,
    skipped: 0,
    errored: 0,
    perTenant: [],
  };

  for (const t of tenants) {
    try {
      const outcome = await evaluateTenantFirmAckRate({
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
          route: "lib/sentiment/firm-ack-monitor",
          tenantId: t.id,
        },
        "firm-ack monitor tenant evaluation failed",
      );
      result.errored += 1;
    }
  }

  return result;
}
