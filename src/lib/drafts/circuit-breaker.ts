import { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { reportError } from "@/lib/observability";

/**
 * Post-PRD hardening item 59 — auto-draft circuit breaker.
 *
 * Item 58 gave operators a manual pause toggle. This is the
 * automatic complement: if the LLM is failing repeatedly for a
 * tenant's auto-draft path (provider outage, scoped model
 * misconfiguration, rate-limited key, schema rejection), the cron
 * would otherwise burn budget retrying every 5 minutes and producing
 * nothing. The breaker reads the `LlmCall` rows item 55 already
 * persists, decides whether to pause, and on the first trip writes
 * the audit event + dispatches a mandatory notification to every
 * FIRM_ADMIN so a human can investigate.
 *
 * Trip rule: at least `FAILURE_THRESHOLD` failed LlmCall rows with
 * `context = "auto-draft"` for this tenant within the last
 * `WINDOW_MINUTES`. A successful call inside the window does NOT
 * reset the counter — the rule is purely "are recent attempts
 * failing too often." Five failures in 30 minutes is the default;
 * a transient blip (1-2 failures) won't trip.
 *
 * Idempotent: a tenant already paused (by anyone — operator or this
 * breaker) is left alone. The audit + notification only fire on the
 * pause-flip transition; subsequent sweep passes see "already
 * paused" and skip iteration cleanly.
 *
 * Sentinel actor: the breaker writes `(circuit-breaker)` to
 * `Tenant.autoDraftPausedByName`. The UI checks for this sentinel
 * to render different banner copy ("Auto-paused after N failures —
 * investigate before resuming") vs operator-initiated copy.
 */

export const FAILURE_THRESHOLD = 5;
export const WINDOW_MINUTES = 30;
export const SENTINEL_ACTOR = "(circuit-breaker)";

export type CircuitBreakerOutcome =
  | { result: "already_paused" }
  | { result: "healthy"; recentFailures: number }
  | {
      result: "auto_paused";
      recentFailures: number;
      windowMinutes: number;
      pausedAt: Date;
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
    select: { autoDraftPausedAt: true, name: true },
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

  // Trip. Pause the tenant first; if dispatch / audit fail, the pause
  // persists and the next sweep pass sees "already paused."
  await superDb.tenant.update({
    where: { id: input.tenantId },
    data: {
      autoDraftPausedAt: now,
      autoDraftPausedByName: SENTINEL_ACTOR,
      autoDraftPauseReason: `Auto-paused after ${recentFailures} failed LLM calls in ${WINDOW_MINUTES} minutes`,
    },
  });

  const auditPayload: Prisma.InputJsonValue = {
    autoPaused: true,
    recentFailures,
    windowMinutes: WINDOW_MINUTES,
    threshold: FAILURE_THRESHOLD,
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
      await dispatchNotification({
        tenantId: input.tenantId,
        membershipId: m.id,
        toEmail: m.user.email,
        kind: "auto_draft_auto_paused",
        dedupeKey,
        subject: `[${tenant.name}] Auto-draft paused — ${recentFailures} failures in ${WINDOW_MINUTES} min`,
        text:
          `The auto-draft engine has paused itself for tenant ${tenant.name} after ` +
          `${recentFailures} failed LLM calls in the last ${WINDOW_MINUTES} minutes. ` +
          `Background drafting from ingested inbound is halted; ad-hoc User drafts via /drafts/new ` +
          `continue to work. Investigate the failure source (check /admin/usage for the failed calls) ` +
          `and click Resume on /admin/channels once the underlying issue is fixed.`,
        summary: `Auto-draft paused after ${recentFailures} failures`,
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
    notifiedMembershipIds,
  };
}
