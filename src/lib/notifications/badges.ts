import type { Membership } from "@prisma/client";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";

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
  /** Total unread NotificationInbox rows for this membership. */
  unreadInbox: number;
};

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

  const [
    fcgProposalsOpen,
    actionsOverdue,
    sentimentMine,
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
    canSeeFirmWide
      ? superDb.sentimentSignal.count({
          where: {
            tenantId,
            escalatedAt: { not: null },
            acknowledgedAt: null,
          },
        })
      : superDb.sentimentSignal.count({
          where: {
            tenantId,
            escalatedAt: { not: null },
            acknowledgedAt: null,
            assignedToMembershipId: membership.id,
          },
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

  const byHref: Record<string, number> = {};
  if (fcgProposalsOpen) byHref[`/${tenantSlug}/fcg`] = fcgProposalsOpen;
  if (actionsOverdue) byHref[`/${tenantSlug}/actions`] = actionsOverdue;
  if (sentimentMine) byHref[`/${tenantSlug}/sentiment`] = sentimentMine;
  if (adherenceMine) byHref[`/${tenantSlug}/adherence/escalations`] = adherenceMine;
  if (breachPending) byHref[`/${tenantSlug}/compliance/breaches`] = breachPending;
  if (inboxUnread) byHref[`/${tenantSlug}/notifications`] = inboxUnread;

  return {
    byHref,
    unreadInbox: inboxUnread,
  };
}
