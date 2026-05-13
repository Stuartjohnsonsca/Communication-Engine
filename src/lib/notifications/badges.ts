import type { Membership } from "@prisma/client";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { bucketDrafts } from "@/lib/drafts/triage";

/**
 * Per-nav-item unread counts for the sidebar. Keyed by the nav `href` so the
 * layout can look up the badge for any link without per-item special casing.
 *
 * Badge values are *outstanding work for the User*, not a literal "unread
 * notification" count — they reflect what would land in the digest if it
 * fired now. The /notifications page itself shows literal unread inbox
 * rows.
 */

export type NavBadges = {
  /** href → numeric badge (0 = no badge). */
  byHref: Record<string, number>;
  /**
   * Items 82 + 94 — per-href tone hint for the sidebar renderer.
   * `stale` is emitted for /sentiment AND /adherence/escalations when
   * the oldest unacked escalation on that pillar has been outstanding
   * longer than `STALE_THRESHOLD_HOURS` (4h, item 77's boundary on the
   * sentiment side; reused for adherence at item 94 so the operator
   * sees the same threshold across both pillars). The renderer paints
   * a red badge instead of black so the Member sees "you have unacked
   * work AND some of it has crossed the stale line" at a glance from
   * any page.
   *
   * `byHref` and `tones` are independent: a stale badge with count 1
   * is meaningfully different from a fresh badge with count 10.
   * Future tones (e.g. `urgent` for >24h) can extend this without
   * touching the badge count contract.
   */
  tones: Record<string, "stale">;
  /** Total unread NotificationInbox rows for this membership. */
  unreadInbox: number;
};

/**
 * Items 82 + 94 — kept in sync with item 77's `STALE_THRESHOLD_HOURS`
 * in `src/lib/sentiment/stale-sweep.ts` AND with item 94's
 * `LiveOutstanding` per-row red-text boundary on /sentiment +
 * /adherence/escalations. Exported so a future per-tenant sensitivity
 * override can reuse it across cron + badge + per-row tone.
 *
 * Adherence has no equivalent stale-sweep cron yet (a future item
 * analogous to 77 / 84 would fire `adherence_escalation_stale` and
 * `firm_adherence_below_threshold` is already the daily floor from
 * item 71). The badge + per-row threshold agree at 4h regardless,
 * so when that cron eventually ships it will also tick at 4h.
 */
const STALE_THRESHOLD_HOURS = 4;

export async function getNavBadges(input: {
  tenantId: string;
  tenantSlug: string;
  membership: Membership;
}): Promise<NavBadges> {
  const { tenantId, tenantSlug, membership } = input;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const canVote = hasPermission(membership.role, "fcg:vote");
  const canSeeFirmWide = hasPermission(membership.role, "members:read");
  const canAckBreach = hasPermission(membership.role, "breach:notify");

  // Item 82 — `sentimentScope` is the per-Member-vs-firm-wide split,
  // factored so the count query AND the stale-oldest query share the
  // exact same predicate. Drift here would mean the badge count says 3
  // (firm-wide view) but the stale flag is computed from a different
  // 5-signal set (self-view), or vice versa.
  const sentimentScope = {
    tenantId,
    escalatedAt: { not: null },
    acknowledgedAt: null,
    ...(canSeeFirmWide ? {} : { assignedToMembershipId: membership.id }),
  };

  // Item 94 — same factoring rule on the adherence side. Note the
  // scope field is `membershipId` (the sender), not
  // `assignedToMembershipId` — adherence escalates the sender of the
  // bad send directly, sentiment routes to an assignee. Sharing this
  // local between the existing `adherenceMine` count AND the new
  // `adherenceOldest` findFirst forecloses the same drift class.
  const adherenceScope = {
    tenantId,
    escalatedAt: { not: null },
    acknowledgedAt: null,
    ...(canSeeFirmWide ? {} : { membershipId: membership.id }),
  };

  const [
    fcgProposalsOpen,
    actionsOverdue,
    openDrafts,
    sentimentMine,
    sentimentOldest,
    adherenceMine,
    adherenceOldest,
    breachPending,
    inboxUnread,
  ] = await Promise.all([
    canVote
      ? superDb.fCGProposal.count({
          where: { tenantId, state: "OPEN_FOR_VOTE" },
        })
      : Promise.resolve(0),
    superDb.action.count({
      where: {
        tenantId,
        membershipId: membership.id,
        status: "OPEN",
        dueAt: { lt: todayStart },
      },
    }),
    // Item 65 — surface FCG-deadline urgency on the sidebar /drafts
    // link. Same lib bucketer as the digest + page so the three
    // surfaces never disagree about what counts as overdue.
    superDb.draft.findMany({
      where: {
        tenantId,
        membershipId: membership.id,
        status: { notIn: ["SENT", "DISCARDED"] },
      },
      select: {
        id: true,
        status: true,
        fcgWindowDeadline: true,
        sentMarkedAt: true,
        createdAt: true,
      },
      take: 200,
    }),
    superDb.sentimentSignal.count({ where: sentimentScope }),
    // Item 82 — oldest unacked escalation in scope, used to compute the
    // `stale` tone flag. `findFirst` with `escalatedAt: asc` is cheap
    // and returns null when there's nothing unacked, which the tone
    // logic below handles as "no badge, no tone."
    superDb.sentimentSignal.findFirst({
      where: sentimentScope,
      select: { escalatedAt: true },
      orderBy: { escalatedAt: "asc" },
    }),
    superDb.communicationAdherence.count({ where: adherenceScope }),
    // Item 94 — oldest unacked adherence escalation, paired with the
    // count above and used to compute the `stale` tone flag for the
    // /adherence/escalations badge. Same `findFirst + escalatedAt asc`
    // shape as the sentiment side; returns null when nothing's unacked
    // (no badge, no tone — tone logic below handles the empty case).
    superDb.communicationAdherence.findFirst({
      where: adherenceScope,
      select: { escalatedAt: true },
      orderBy: { escalatedAt: "asc" },
    }),
    canAckBreach
      ? superDb.breachClientNotification.count({
          where: { tenantId, status: "NOTIFIED" },
        })
      : Promise.resolve(0),
    superDb.notificationInbox.count({
      where: {
        tenantId,
        membershipId: membership.id,
        readAt: null,
      },
    }),
  ]);

  // Item 65 — overdue drafts only. due_soon is visible inside /drafts
  // (item 64) but the badge is reserved for "the firm has missed its
  // FCG-window promise"; anything weaker dilutes the signal.
  const draftsOverdue = bucketDrafts(openDrafts).overdue.length;

  const byHref: Record<string, number> = {};
  if (fcgProposalsOpen) byHref[`/${tenantSlug}/fcg`] = fcgProposalsOpen;
  if (actionsOverdue) byHref[`/${tenantSlug}/actions`] = actionsOverdue;
  if (draftsOverdue) byHref[`/${tenantSlug}/drafts`] = draftsOverdue;
  if (sentimentMine) byHref[`/${tenantSlug}/sentiment`] = sentimentMine;
  if (adherenceMine) byHref[`/${tenantSlug}/adherence/escalations`] = adherenceMine;
  if (breachPending) byHref[`/${tenantSlug}/compliance/breaches`] = breachPending;
  if (inboxUnread) byHref[`/${tenantSlug}/notifications`] = inboxUnread;

  // Items 82 + 94 — stale-tone flags for the sentiment AND adherence
  // badges. Each tone is only emitted when its badge is present
  // (`*Mine > 0`); a tone on a zero-count badge would never render.
  // Threshold is shared (`STALE_THRESHOLD_HOURS`) so the operator's
  // mental model is "4h = bad" across both pillars + cron (item 77 on
  // sentiment side) + per-row red text (item 94's `LiveOutstanding`).
  //
  // `now` snapshotted once so the two pillars judge staleness against
  // an identical clock — otherwise on a slow query path the badges
  // could trip on different cutoffs by milliseconds (harmless but
  // wrong-by-construction).
  const now = Date.now();
  const staleMs = STALE_THRESHOLD_HOURS * 60 * 60_000;
  const tones: Record<string, "stale"> = {};
  if (sentimentMine > 0 && sentimentOldest?.escalatedAt) {
    if (now - sentimentOldest.escalatedAt.getTime() > staleMs) {
      tones[`/${tenantSlug}/sentiment`] = "stale";
    }
  }
  if (adherenceMine > 0 && adherenceOldest?.escalatedAt) {
    if (now - adherenceOldest.escalatedAt.getTime() > staleMs) {
      tones[`/${tenantSlug}/adherence/escalations`] = "stale";
    }
  }

  return {
    byHref,
    tones,
    unreadInbox: inboxUnread,
  };
}
