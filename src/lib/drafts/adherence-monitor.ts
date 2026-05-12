import { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { isoWeekKey } from "@/lib/notifications/digest";
import { reportError } from "@/lib/observability";
import { computeDraftRollup } from "./rollup";

/**
 * Post-PRD hardening item 71 — low-adherence escalation alert.
 *
 * Items 66–69 made FCG-window adherence visible (firm rollup, per-Member
 * breakdown, CSV export, Member self-view). They all rely on a FIRM_ADMIN
 * actively visiting the page. This worker closes the gap: when a tenant's
 * 7-day adherence rate falls below `ADHERENCE_THRESHOLD` with a
 * meaningful volume of deadlined sends, every active FIRM_ADMIN gets
 * pushed an email + in-app inbox notification. The FCG response window
 * is the engine's central client-facing promise — silently missing it is
 * exactly the failure mode this engine exists to prevent.
 *
 * **Volume floor (`MIN_DEADLINED_SENDS`)** is load-bearing. Without it,
 * a brand-new tenant with two deadlined sends and one missed (50%) trips
 * the alert and trains operators to dismiss it. The floor — 10 deadlined
 * sends in the 7-day window — means the rate is computed from enough
 * data that "you're below threshold" is operationally meaningful.
 * Tenants below the floor return `result: "skipped_low_volume"` and
 * silently pass; nothing is escalated, nothing is audited (the page
 * already shows their raw counts).
 *
 * **No-data short-circuit**: tenants with `withinWindowRate === null`
 * (no deadlined sends at all) also skip — `null` already means "no
 * promise to measure", same invariant as items 66/69.
 *
 * **Dedupe is per ISO week.** A tenant that's chronically below
 * threshold gets one alert per Monday-to-Sunday window. dedupeKey is
 * `firm-adherence-below:<isoWeek>` so a daily cron run is a no-op after
 * the first trip in any given week. The Member-facing draft_stale path
 * (item 54) fires per-draft; this firm-wide signal fires per-week.
 *
 * **Audit lands on the affected tenant's chain.** A FIRM_ADMIN reading
 * their own audit log will see "we got flagged for low adherence on
 * 2026-W19" as a stable record — cross-tenant operator chains (Acumon)
 * would make this invisible to the affected tenant's own auditors.
 *
 * Skip conditions returned in the result (for observability, not as
 * errors):
 *   - tenant has no deadlined sends in window
 *   - tenant has fewer than `MIN_DEADLINED_SENDS` deadlined sends
 *   - tenant's `withinWindowRate >= ADHERENCE_THRESHOLD`
 *   - dispatch row already exists for this (tenant, ISO week)
 */

/// 7-day rolling window. Matches the existing /admin/drafts default
/// short window — a longer window would be slower to react to a real
/// degradation; a shorter window would be noisier.
export const WINDOW_DAYS = 7;

/// Below this rate trips the alert. 0.80 ≈ "we're missing one in five
/// FCG promises". Picking 80% rather than something stricter (e.g. 90%)
/// keeps the alert from firing on small statistical wobble at higher
/// volumes; firms that want a stricter bar can set a tenant-level
/// override in a future item without code change here.
export const ADHERENCE_THRESHOLD = 0.8;

/// Minimum deadlined-send volume to consider the rate meaningful. Picked
/// to be high enough that "rate < 80%" cannot be hit by chance from a
/// near-empty inbox, low enough that any active firm reaches it in a
/// 7-day window. Adjust here if the volume floor turns out to be the
/// wrong shape; tests pin both threshold + volume.
export const MIN_DEADLINED_SENDS = 10;

export type AdherenceMonitorOutcome =
  | { result: "no_data" }
  | { result: "skipped_low_volume"; sentWithDeadline: number }
  | {
      result: "above_threshold";
      sentWithDeadline: number;
      withinWindowRate: number;
    }
  | { result: "already_alerted_this_week"; isoWeek: string }
  | {
      result: "alerted";
      isoWeek: string;
      sentWithDeadline: number;
      sentWithinWindow: number;
      sentAfterWindow: number;
      openOverdue: number;
      withinWindowRate: number;
      notifiedMembershipIds: string[];
    };

export type AdherenceMonitorRunResult = {
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
  perTenant: Array<{ tenantId: string; outcome: AdherenceMonitorOutcome }>;
};

/**
 * Evaluate one tenant. Pure function over the rollup + dispatch table;
 * the cron caller is just a fan-out + error-isolation wrapper.
 */
export async function evaluateTenantAdherence(input: {
  tenantId: string;
  now?: Date;
}): Promise<AdherenceMonitorOutcome> {
  const now = input.now ?? new Date();
  const isoWeek = isoWeekKey(now);

  // Reuse the firm-wide rollup so this can't drift from /admin/drafts.
  // We only need the firm-wide block, but skipping the per-Member top-N
  // sort isn't worth a second code path.
  const rollup = await computeDraftRollup({
    tenantId: input.tenantId,
    windowDays: WINDOW_DAYS,
  });

  const { sentWithDeadline, sentWithinWindow, sentAfterWindow, openOverdue, withinWindowRate } =
    rollup.fcgWindow;

  // No deadlined sends in window — no promise to measure. Items 66/69's
  // null-rate invariant applies: don't synthesise a 0/0 alert.
  if (withinWindowRate === null) {
    return { result: "no_data" };
  }

  // Volume floor — small denominators don't get to fire the alert.
  if (sentWithDeadline < MIN_DEADLINED_SENDS) {
    return { result: "skipped_low_volume", sentWithDeadline };
  }

  if (withinWindowRate >= ADHERENCE_THRESHOLD) {
    return { result: "above_threshold", sentWithDeadline, withinWindowRate };
  }

  // Below threshold + above volume floor → trip the alert.
  const dedupeKey = `firm-adherence-below:${isoWeek}`;

  // Idempotency probe via the dispatch table — same membership-scoped
  // unique key as `dispatchNotification` uses. We probe before fanning
  // out so we don't write an audit row if every recipient is already
  // notified. Worth noting: the unique constraint is (membership, kind,
  // dedupeKey), so we have to probe a known membership. We check the
  // first active FIRM_ADMIN; if a new FIRM_ADMIN joins mid-week they
  // still receive their first notification via the per-membership loop
  // below (dispatchNotification is idempotent per recipient).
  const tenant = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: { name: true },
  });
  if (!tenant) {
    return { result: "no_data" };
  }

  const admins = await superDb.membership.findMany({
    where: { tenantId: input.tenantId, role: "FIRM_ADMIN", status: "ACTIVE" },
    include: { user: { select: { email: true } } },
  });

  if (admins.length === 0) {
    // No FIRM_ADMIN to notify. Audit nothing — there's no governance
    // outcome to record because there's no governance recipient. The
    // /admin/drafts page still shows the rate in the UI.
    return { result: "no_data" };
  }

  // Probe the first admin's dispatch row to skip the audit + fan-out if
  // this week is already alerted.
  const probe = await superDb.notificationDispatch.findUnique({
    where: {
      membershipId_kind_dedupeKey: {
        membershipId: admins[0].id,
        kind: "firm_adherence_below_threshold",
        dedupeKey,
      },
    },
  });
  if (probe) {
    return { result: "already_alerted_this_week", isoWeek };
  }

  const pct = Math.round(withinWindowRate * 100);
  const threshPct = Math.round(ADHERENCE_THRESHOLD * 100);
  const subject = `[${tenant.name}] FCG-window adherence below ${threshPct}% (${pct}% over ${WINDOW_DAYS}d)`;
  const text =
    `The firm's FCG response-window adherence over the last ${WINDOW_DAYS} days is ${pct}%, ` +
    `below the ${threshPct}% threshold.\n\n` +
    `Deadlined sends in window: ${sentWithDeadline}\n` +
    `On time: ${sentWithinWindow}\n` +
    `After window: ${sentAfterWindow}\n` +
    `Open + overdue: ${openOverdue}\n\n` +
    `Open /admin/drafts for the per-Member breakdown. The FCG promised a response window for ` +
    `each of these threads; this alert means the firm is currently breaking that promise more ` +
    `often than the ${threshPct}% bar permits. One alert per week — escalation will not re-fire ` +
    `until next ISO week even if the rate stays below threshold.`;

  const auditPayload: Prisma.InputJsonValue = {
    windowDays: WINDOW_DAYS,
    sentWithDeadline,
    sentWithinWindow,
    sentAfterWindow,
    openOverdue,
    withinWindowRate,
    threshold: ADHERENCE_THRESHOLD,
    minDeadlinedSends: MIN_DEADLINED_SENDS,
    isoWeek,
  };

  // Audit FIRST so the chain reflects the trip even if every recipient
  // dispatch fails. The page (item 66) is the canonical truth source;
  // this row is the "we noticed and tried to tell people" record.
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "FIRM_ADHERENCE_BELOW_THRESHOLD",
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
        kind: "firm_adherence_below_threshold",
        dedupeKey,
        subject,
        text,
        summary: `FCG-window adherence ${pct}% over ${WINDOW_DAYS}d (threshold ${threshPct}%)`,
        href: `/admin/drafts`,
        payload: auditPayload,
      });
      notifiedMembershipIds.push(m.id);
    } catch (err) {
      reportError(
        err,
        {
          route: "lib/drafts/adherence-monitor",
          tenantId: input.tenantId,
          membershipId: m.id,
        },
        "firm-adherence escalation notification dispatch failed",
      );
    }
  }

  return {
    result: "alerted",
    isoWeek,
    sentWithDeadline,
    sentWithinWindow,
    sentAfterWindow,
    openOverdue,
    withinWindowRate,
    notifiedMembershipIds,
  };
}

/**
 * Cron entry point. Iterates every tenant and evaluates them in
 * isolation — one tenant's failure doesn't abort the pass.
 */
export async function runAdherenceMonitor(opts?: {
  /** Override "now" — tests pin a deterministic clock. */
  now?: Date;
  /** Restrict to a single tenant — tests / on-demand. */
  tenantId?: string;
}): Promise<AdherenceMonitorRunResult> {
  const tenants = await superDb.tenant.findMany({
    where: opts?.tenantId ? { id: opts.tenantId } : undefined,
    select: { id: true },
  });

  const result: AdherenceMonitorRunResult = {
    scanned: tenants.length,
    alerted: 0,
    alreadyAlerted: 0,
    skipped: 0,
    errored: 0,
    perTenant: [],
  };

  for (const t of tenants) {
    try {
      const outcome = await evaluateTenantAdherence({
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
          route: "lib/drafts/adherence-monitor",
          tenantId: t.id,
        },
        "adherence monitor tenant evaluation failed",
      );
      result.errored += 1;
    }
  }

  return result;
}
