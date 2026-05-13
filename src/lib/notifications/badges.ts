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
   * Item 82 — per-href tone hint for the sidebar renderer. Today only
   * `stale` is emitted, for the /sentiment row when the oldest unacked
   * escalation has been outstanding longer than `STALE_THRESHOLD_HOURS`
   * (item 77's 4h boundary — same number the stale-sweep cron uses to
   * fire `sentiment_escalation_stale`). The renderer paints a red badge
   * instead of black so the Member sees "you have unacked work AND some
   * of it has crossed the stale line" at a glance from any page.
   *
   * `byHref` and `tones` are independent: a stale sentiment badge with
   * count 1 is meaningfully different from a fresh sentiment badge with
   * count 10. Future tones (e.g. `urgent` for >24h) can extend this
   * without touching the badge count contract.
   */
  tones: Record<string, "stale">;
  /** Total unread NotificationInbox rows for this membership. */
  unreadInbox: number;
};

/**
 * Item 82 — kept in sync with item 77's `STALE_THRESHOLD_HOURS` in
 * `src/lib/sentiment/stale-sweep.ts`. Exported so a future per-tenant
 * sensitivity override can reuse it for both the cron and the badge.
 */
const SENTIMENT_STALE_THRESHOLD_HOURS = 4;

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

  const [
    fcgProposalsOpen,
    actionsOverdue,
    openDrafts,
    sentimentMine,
    sentimentOldest,
    adherenceMine,
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
    canSeeFirmWide
      ? superDb.communicationAdherence.count({
          where: {
            tenantId,
            escalatedAt: { not: null },
            acknowledgedAt: null,
          },
        })
      : superDb.communicationAdherence.count({
          where: {
            tenantId,
            escalatedAt: { not: null },
            acknowledgedAt: null,
            membershipId: membership.id,
          },
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

  // Item 82 — stale-tone flag for the sentiment badge. Only emitted
  // when the badge itself is present (sentimentMine > 0); a tone on
  // a zero-count badge would never be rendered anyway. Threshold
  // matches item 77's cron — same number, so the badge turns red at
  // exactly the moment the stale-sweep cron would have warned (or
  // already has).
  const tones: Record<string, "stale"> = {};
  if (sentimentMine > 0 && sentimentOldest?.escalatedAt) {
    const ageMs = Date.now() - sentimentOldest.escalatedAt.getTime();
    if (ageMs > SENTIMENT_STALE_THRESHOLD_HOURS * 60 * 60_000) {
      tones[`/${tenantSlug}/sentiment`] = "stale";
    }
  }

  return {
    byHref,
    tones,
    unreadInbox: inboxUnread,
  };
}
