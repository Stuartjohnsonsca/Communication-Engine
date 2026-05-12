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
