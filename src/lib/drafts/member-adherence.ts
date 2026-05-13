/**
 * Post-PRD hardening item 69 — per-Member FCG-window adherence helper
 * for the Member's own /account page.
 *
 * Item 67 added a Top drafters table on /admin/drafts so the FIRM_ADMIN
 * sees who's slipping. This is the matching first-person view: each
 * Member should see their own number on /account so they can self-
 * correct without waiting for a top-down conversation. The view is
 * authoritatively the same metric — same exclusions, same denominator,
 * same window options — but computed with a narrow per-Membership
 * query rather than scanning every draft in the tenant.
 *
 * Exclusions match items 66 + 67:
 *   - bypassed-synth (`synthesisedFromOutboundIngest=true`) excluded
 *     entirely (no engine promise applied)
 *   - drafts without `fcgWindowDeadline` excluded (no promise to keep)
 *   - DISCARDED excluded from openOverdue (operator marked it out of
 *     scope; not a broken promise)
 */

import { superDb } from "@/lib/db";

export type MemberFcgAdherenceWindow = 7 | 30 | 90;

export type MemberFcgAdherence = {
  windowDays: number;
  sentWithDeadline: number;
  sentWithinWindow: number;
  sentAfterWindow: number;
  openOverdue: number;
  /// sentWithinWindow / sentWithDeadline. Null when no deadlined sends
  /// — surface to the UI as "no deadlined sends yet" rather than 0%.
  withinWindowRate: number | null;
};

/**
 * Post-PRD hardening item 73 — per-Member FCG-window rate over an
 * arbitrary `[since, until)` range. The matching first-person helper
 * for `computeFcgAdherenceForRange` (item 72), used by the /account
 * trend pill to compare a Member's current 30d adherence against their
 * own immediately-prior 30d.
 *
 * Same exclusions as `computeMemberFcgAdherence` and the firm-wide
 * trend helper: bypassed-synth drafts never count, drafts without
 * `fcgWindowDeadline` never count, and only SENT rows contribute to
 * the rate.
 *
 * `withinWindowRate` is null when `sentWithDeadline === 0` — same
 * null-when-no-data invariant the rest of the codebase uses. The pill
 * then renders nothing rather than faking a 0pp delta against missing
 * data.
 *
 * Open-overdue is NOT computed for the prior window — same reason as
 * item 72: "what was open and overdue 30 days ago" requires status as
 * of historic point, which is a different query shape and isn't load-
 * bearing for a rate-vs-rate pill.
 */
export type MemberFcgAdherenceForRange = {
  sentWithDeadline: number;
  sentWithinWindow: number;
  sentAfterWindow: number;
  withinWindowRate: number | null;
};

export async function computeMemberFcgAdherence(input: {
  tenantId: string;
  membershipId: string;
  windowDays?: MemberFcgAdherenceWindow;
}): Promise<MemberFcgAdherence> {
  const windowDays = input.windowDays ?? 30;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await superDb.draft.findMany({
    where: {
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      createdAt: { gte: since },
      // Excluded at the query layer — bypassed-synth drafts have no
      // engine promise; pulling them only to drop them in-app would
      // waste bytes.
      synthesisedFromOutboundIngest: false,
      // No-deadline drafts also excluded at the query layer. The page
      // surface gives a sense of "did you miss any" — drafts that
      // never had a deadline can't have been missed.
      fcgWindowDeadline: { not: null },
    },
    select: {
      status: true,
      fcgWindowDeadline: true,
      sentMarkedAt: true,
    },
    // Cap defensive — a Member with > 50k deadlined drafts in 90d is
    // either misconfigured or a load-test artefact.
    take: 50_000,
  });

  const now = new Date();
  let sentWithDeadline = 0;
  let sentWithinWindow = 0;
  let sentAfterWindow = 0;
  let openOverdue = 0;

  for (const r of rows) {
    // `fcgWindowDeadline` is filtered to non-null in the query, but the
    // type is still nullable — narrow before reading.
    if (!r.fcgWindowDeadline) continue;
    const deadline = r.fcgWindowDeadline.getTime();
    if (r.status === "SENT" && r.sentMarkedAt) {
      sentWithDeadline += 1;
      if (r.sentMarkedAt.getTime() <= deadline) sentWithinWindow += 1;
      else sentAfterWindow += 1;
    } else if (r.status !== "SENT" && r.status !== "DISCARDED") {
      if (deadline < now.getTime()) openOverdue += 1;
    }
  }

  return {
    windowDays,
    sentWithDeadline,
    sentWithinWindow,
    sentAfterWindow,
    openOverdue,
    withinWindowRate:
      sentWithDeadline > 0 ? sentWithinWindow / sentWithDeadline : null,
  };
}

export async function computeMemberFcgAdherenceForRange(input: {
  tenantId: string;
  membershipId: string;
  since: Date;
  until: Date;
}): Promise<MemberFcgAdherenceForRange> {
  const rows = await superDb.draft.findMany({
    where: {
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      createdAt: { gte: input.since, lt: input.until },
      // Same exclusions as `computeMemberFcgAdherence` — applied at the
      // query layer so we don't pay to fetch rows we'd only drop.
      synthesisedFromOutboundIngest: false,
      fcgWindowDeadline: { not: null },
      status: "SENT",
    },
    select: {
      sentMarkedAt: true,
      fcgWindowDeadline: true,
    },
    take: 50_000,
  });

  let sentWithinWindow = 0;
  let sentAfterWindow = 0;
  for (const r of rows) {
    if (!r.fcgWindowDeadline || !r.sentMarkedAt) continue;
    if (r.sentMarkedAt.getTime() <= r.fcgWindowDeadline.getTime()) {
      sentWithinWindow += 1;
    } else {
      sentAfterWindow += 1;
    }
  }
  const sentWithDeadline = sentWithinWindow + sentAfterWindow;
  return {
    sentWithDeadline,
    sentWithinWindow,
    sentAfterWindow,
    withinWindowRate:
      sentWithDeadline > 0 ? sentWithinWindow / sentWithDeadline : null,
  };
}

/**
 * Convenience wrapper: the immediately-prior same-length window for
 * the given Membership. For a 30d call, returns adherence over the
 * [-60d, -30d) range. Current and prior never overlap — the cutoff is
 * `now - windowDays`, used as both `until` of prior and (implicitly,
 * via `computeMemberFcgAdherence`'s `since = now - windowDays`) `since`
 * of current.
 */
export async function computeMemberPriorPeriodFcgRate(input: {
  tenantId: string;
  membershipId: string;
  windowDays: number;
  now?: Date;
}): Promise<MemberFcgAdherenceForRange> {
  const now = input.now ?? new Date();
  const windowMs = input.windowDays * 24 * 60 * 60 * 1000;
  const until = new Date(now.getTime() - windowMs);
  const since = new Date(until.getTime() - windowMs);
  return computeMemberFcgAdherenceForRange({
    tenantId: input.tenantId,
    membershipId: input.membershipId,
    since,
    until,
  });
}
