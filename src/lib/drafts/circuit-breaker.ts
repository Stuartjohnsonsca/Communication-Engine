import { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { reportError } from "@/lib/observability";

/**
 * Post-PRD hardening items 59 + 61 — auto-draft circuit breaker
 * (trip + auto-resume).
 *
 * Item 58 gave operators a manual pause toggle. Item 59 added the
 * automatic trip: if the LLM is failing repeatedly for a tenant's
 * auto-draft path, the cron auto-pauses, audits, and notifies
 * FIRM_ADMINs. Item 61 (this addition) closes the loop: when the
 * underlying issue clears, the breaker auto-resumes — so a 10-minute
 * provider outage doesn't leave the engine off for 12 hours waiting
 * for somebody to notice and click Resume.
 *
 * Trip rule: at least `FAILURE_THRESHOLD` failed LlmCall rows with
 * `context = "auto-draft"` for this tenant within the last
 * `WINDOW_MINUTES`. A successful call inside the window does NOT
 * reset the counter — the rule is "are recent attempts failing too
 * often." Five failures in 30 minutes is the default; a transient
 * blip won't trip.
 *
 * Auto-resume rule (item 61):
 *   - Only when paused with the `(circuit-breaker)` sentinel
 *     (never operator-paused; never `(circuit-breaker-locked)`).
 *   - Tenant has been paused for at least `MIN_PAUSE_MINUTES`. Stops
 *     the breaker from auto-resuming on the same cron tick it just
 *     tripped on (clock skew + window-edge races).
 *   - No failed `auto-draft` LlmCall rows in the last
 *     `RESUME_WINDOW_MINUTES`. We deliberately do NOT require recent
 *     SUCCESSES — a paused tenant produces no auto-draft traffic,
 *     so insisting on a success would deadlock. The trip's own
 *     window-based count naturally drops as old failures age out.
 *
 * Anti-thrash (item 61): on every trip, the breaker inspects
 * `Tenant.autoDraftAutoResumeAt`. If the previous auto-resume was
 * within `THRASH_WINDOW_MINUTES`, the breaker switches the sentinel
 * to `LOCKED_SENTINEL_ACTOR` and refuses to auto-resume — the issue
 * isn't transient and a human needs to investigate. Operator manual
 * resume clears `autoDraftAutoResumeAt`, giving a clean slate.
 *
 * Idempotent: a tenant already paused (by anyone — operator,
 * breaker, locked breaker) is left alone by the TRIP path. The
 * resume path runs from any state and short-circuits if it isn't
 * eligible.
 *
 * Sentinel actors: the breaker writes `(circuit-breaker)` on a
 * normal trip and `(circuit-breaker-locked)` on a thrash-window
 * re-trip. The UI checks for both to render banner copy — operator-
 * initiated pauses keep the amber treatment; both breaker variants
 * get red, with locked carrying a stronger "investigate before
 * resuming" message.
 */

export const FAILURE_THRESHOLD = 5;
export const WINDOW_MINUTES = 30;
export const SENTINEL_ACTOR = "(circuit-breaker)";

// Item 61 constants.
export const LOCKED_SENTINEL_ACTOR = "(circuit-breaker-locked)";
/// Minimum pause duration before auto-resume is eligible. Five
/// minutes ≪ trip window (30 min); enough to outlast cron-tick races
/// but short enough that a clean transient outage recovers fast.
export const MIN_PAUSE_MINUTES = 5;
/// Lookback for the "is it clean now" check. Matches the trip window
/// — once the trip-window count drops below threshold, auto-resume is
/// eligible. Different value would create a hysteresis loop.
export const RESUME_WINDOW_MINUTES = WINDOW_MINUTES;
/// If a previous auto-resume happened within this window before a
/// re-trip, the breaker locks the pause (requires human review).
/// Four hours is enough that a genuine recurring problem trips the
/// lock; short enough that yesterday's incident doesn't penalise a
/// truly independent failure today.
export const THRASH_WINDOW_MINUTES = 240;

export type CircuitBreakerOutcome =
  | { result: "already_paused" }
  | { result: "healthy"; recentFailures: number }
  | {
      result: "auto_paused";
      recentFailures: number;
      windowMinutes: number;
      pausedAt: Date;
      pausedByName: string; // SENTINEL_ACTOR or LOCKED_SENTINEL_ACTOR
      threshLocked: boolean;
      notifiedMembershipIds: string[];
    };

export type AutoResumeOutcome =
  | { result: "not_paused" }
  | { result: "skipped_not_eligible"; pausedByName: string | null }
  | { result: "skipped_too_recent"; pausedForMinutes: number }
  | { result: "skipped_still_failing"; recentFailures: number }
  | {
      result: "auto_resumed";
      pausedDurationMinutes: number;
      recentFailures: number;
      notifiedMembershipIds: string[];
    };

/**
 * Evaluate (and possibly trip) the breaker for one tenant. Safe to
 * call from any caller that's about to do auto-draft work; returns
 * synchronously without dispatch when the tenant is already paused
 * or below threshold.
 */
export async function evaluateAutoPauseCircuitBreaker(input: {
  tenantId: string;
  now?: Date;
}): Promise<CircuitBreakerOutcome> {
  const now = input.now ?? new Date();

  const tenant = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: {
      autoDraftPausedAt: true,
      autoDraftAutoResumeAt: true,
      name: true,
    },
  });
  if (!tenant) return { result: "healthy", recentFailures: 0 };
  if (tenant.autoDraftPausedAt) return { result: "already_paused" };

  const windowStart = new Date(now.getTime() - WINDOW_MINUTES * 60 * 1000);
  const recentFailures = await superDb.llmCall.count({
    where: {
      tenantId: input.tenantId,
      context: "auto-draft",
      succeeded: false,
      createdAt: { gte: windowStart },
    },
  });

  if (recentFailures < FAILURE_THRESHOLD) {
    return { result: "healthy", recentFailures };
  }

  // Item 61 — thrash detection. If we auto-resumed within the thrash
  // window and we're about to trip again, the issue isn't transient.
  // Pause with the LOCKED sentinel so auto-resume refuses to act
  // and the UI shows a stronger "investigate first" message.
  const thrashCutoff = new Date(
    now.getTime() - THRASH_WINDOW_MINUTES * 60 * 1000,
  );
  const threshLocked =
    !!tenant.autoDraftAutoResumeAt && tenant.autoDraftAutoResumeAt > thrashCutoff;
  const sentinel = threshLocked ? LOCKED_SENTINEL_ACTOR : SENTINEL_ACTOR;
  const reason = threshLocked
    ? `Locked after re-trip within ${THRASH_WINDOW_MINUTES} min of auto-resume; ${recentFailures} failures in ${WINDOW_MINUTES} min — manual review required`
    : `Auto-paused after ${recentFailures} failed LLM calls in ${WINDOW_MINUTES} minutes`;

  // Trip. Pause the tenant first; if dispatch / audit fail, the pause
  // persists and the next sweep pass sees "already paused."
  await superDb.tenant.update({
    where: { id: input.tenantId },
    data: {
      autoDraftPausedAt: now,
      autoDraftPausedByName: sentinel,
      autoDraftPauseReason: reason,
    },
  });

  const auditPayload: Prisma.InputJsonValue = {
    autoPaused: true,
    recentFailures,
    windowMinutes: WINDOW_MINUTES,
    threshold: FAILURE_THRESHOLD,
    threshLocked,
  };
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "AUTO_DRAFT_PAUSED",
    actorMembershipId: null, // system-driven; no user actor
    subjectType: "Tenant",
    subjectId: input.tenantId,
    payload: auditPayload,
  });

  // Notify every active FIRM_ADMIN. Mandatory kind — not opt-outable.
  // dedupeKey is the pause timestamp so re-running this fn (e.g. tests)
  // for the same trip never double-dispatches.
  const admins = await superDb.membership.findMany({
    where: {
      tenantId: input.tenantId,
      role: "FIRM_ADMIN",
      status: "ACTIVE",
    },
    include: { user: { select: { email: true, name: true } } },
  });
  const notifiedMembershipIds: string[] = [];
  const dedupeKey = `auto-paused:${now.toISOString()}`;
  for (const m of admins) {
    if (!m.user.email) continue;
    try {
      const subjectSuffix = threshLocked
        ? `LOCKED after re-trip — manual review required`
        : `${recentFailures} failures in ${WINDOW_MINUTES} min`;
      const bodyBase =
        `The auto-draft engine has paused itself for tenant ${tenant.name} after ` +
        `${recentFailures} failed LLM calls in the last ${WINDOW_MINUTES} minutes. ` +
        `Background drafting from ingested inbound is halted; ad-hoc User drafts via /drafts/new ` +
        `continue to work.`;
      const bodyTail = threshLocked
        ? ` This is a RE-TRIP within ${THRASH_WINDOW_MINUTES} minutes of a previous auto-resume — the issue is recurring, not transient. ` +
          `Auto-resume is DISABLED for this pause. Investigate (check /admin/usage for failed calls) and click Resume on /admin/channels once fixed.`
        : ` Auto-resume will fire on the next cron tick after the failure window clears (${RESUME_WINDOW_MINUTES} min). ` +
          `If the issue is non-transient, investigate /admin/usage and resume manually.`;
      await dispatchNotification({
        tenantId: input.tenantId,
        membershipId: m.id,
        toEmail: m.user.email,
        kind: "auto_draft_auto_paused",
        dedupeKey,
        subject: `[${tenant.name}] Auto-draft paused — ${subjectSuffix}`,
        text: bodyBase + bodyTail,
        summary: threshLocked
          ? `Auto-draft LOCKED after re-trip`
          : `Auto-draft paused after ${recentFailures} failures`,
        href: `/admin/channels`,
        payload: auditPayload,
      });
      notifiedMembershipIds.push(m.id);
    } catch (err) {
      reportError(
        err,
        {
          route: "lib/drafts/circuit-breaker",
          tenantId: input.tenantId,
          membershipId: m.id,
        },
        "auto-pause notification dispatch failed",
      );
    }
  }

  return {
    result: "auto_paused",
    recentFailures,
    windowMinutes: WINDOW_MINUTES,
    pausedAt: now,
    pausedByName: sentinel,
    threshLocked,
    notifiedMembershipIds,
  };
}

/**
 * Item 61 — auto-resume eligibility check + resume action.
 *
 * Called once per tenant per CRON sweep tick BEFORE the trip
 * evaluation. If the tenant is paused under the `(circuit-breaker)`
 * sentinel and the failure window has cleared, this clears the pause
 * fields, stamps `autoDraftAutoResumeAt`, writes an
 * `AUTO_DRAFT_RESUMED` audit row with `autoResumed: true`, and
 * notifies FIRM_ADMINs.
 *
 * Refuses to resume:
 *   - operator pauses (any non-sentinel name)
 *   - `LOCKED_SENTINEL_ACTOR` pauses (anti-thrash)
 *   - pauses younger than `MIN_PAUSE_MINUTES`
 *   - pauses with any failed `auto-draft` LlmCall in the resume window
 */
export async function evaluateAutoResume(input: {
  tenantId: string;
  now?: Date;
}): Promise<AutoResumeOutcome> {
  const now = input.now ?? new Date();

  const tenant = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: {
      name: true,
      autoDraftPausedAt: true,
      autoDraftPausedByName: true,
    },
  });
  if (!tenant) return { result: "not_paused" };
  if (!tenant.autoDraftPausedAt) return { result: "not_paused" };

  // Only the bare circuit-breaker sentinel is eligible. Operator
  // pauses (any other name) and locked re-trips are not.
  if (tenant.autoDraftPausedByName !== SENTINEL_ACTOR) {
    return {
      result: "skipped_not_eligible",
      pausedByName: tenant.autoDraftPausedByName,
    };
  }

  const pausedForMinutes = Math.floor(
    (now.getTime() - tenant.autoDraftPausedAt.getTime()) / 60_000,
  );
  if (pausedForMinutes < MIN_PAUSE_MINUTES) {
    return { result: "skipped_too_recent", pausedForMinutes };
  }

  const windowStart = new Date(
    now.getTime() - RESUME_WINDOW_MINUTES * 60 * 1000,
  );
  const recentFailures = await superDb.llmCall.count({
    where: {
      tenantId: input.tenantId,
      context: "auto-draft",
      succeeded: false,
      createdAt: { gte: windowStart },
    },
  });
  if (recentFailures > 0) {
    return { result: "skipped_still_failing", recentFailures };
  }

  // Resume. Clear pause fields; stamp `autoDraftAutoResumeAt` so the
  // trip path can detect thrash on a subsequent re-trip.
  await superDb.tenant.update({
    where: { id: input.tenantId },
    data: {
      autoDraftPausedAt: null,
      autoDraftPausedByName: null,
      autoDraftPauseReason: null,
      autoDraftAutoResumeAt: now,
    },
  });

  const auditPayload: Prisma.InputJsonValue = {
    autoResumed: true,
    pausedDurationMinutes: pausedForMinutes,
    recentFailures,
    resumeWindowMinutes: RESUME_WINDOW_MINUTES,
  };
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "AUTO_DRAFT_RESUMED",
    actorMembershipId: null,
    subjectType: "Tenant",
    subjectId: input.tenantId,
    payload: auditPayload,
  });

  // Notify FIRM_ADMINs — operators need to know the engine is back
  // online (so they don't go investigating a "stuck" pause that
  // already cleared itself).
  const admins = await superDb.membership.findMany({
    where: {
      tenantId: input.tenantId,
      role: "FIRM_ADMIN",
      status: "ACTIVE",
    },
    include: { user: { select: { email: true, name: true } } },
  });
  const notifiedMembershipIds: string[] = [];
  const dedupeKey = `auto-resumed:${now.toISOString()}`;
  for (const m of admins) {
    if (!m.user.email) continue;
    try {
      await dispatchNotification({
        tenantId: input.tenantId,
        membershipId: m.id,
        toEmail: m.user.email,
        kind: "auto_draft_auto_resumed",
        dedupeKey,
        subject: `[${tenant.name}] Auto-draft resumed automatically`,
        text:
          `The auto-draft engine has automatically resumed for tenant ${tenant.name}. ` +
          `It was paused by the circuit breaker for ${pausedForMinutes} minute(s) after ` +
          `repeated LLM failures, and the failure window (last ${RESUME_WINDOW_MINUTES} min) ` +
          `is now clean. Background drafting from ingested inbound is producing again. ` +
          `If the same issue trips the breaker again within ${THRASH_WINDOW_MINUTES} min, ` +
          `the next pause will LOCK and require manual review.`,
        summary: `Auto-draft resumed after ${pausedForMinutes} min`,
        href: `/admin/channels`,
        payload: auditPayload,
      });
      notifiedMembershipIds.push(m.id);
    } catch (err) {
      reportError(
        err,
        {
          route: "lib/drafts/circuit-breaker",
          tenantId: input.tenantId,
          membershipId: m.id,
        },
        "auto-resume notification dispatch failed",
      );
    }
  }

  return {
    result: "auto_resumed",
    pausedDurationMinutes: pausedForMinutes,
    recentFailures,
    notifiedMembershipIds,
  };
}
