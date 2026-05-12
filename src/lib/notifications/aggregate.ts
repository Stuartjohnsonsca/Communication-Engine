import type { Membership, Tenant, User } from "@prisma/client";
import { superDb } from "@/lib/db";
import { getDpiaStatus } from "@/lib/dpia/status";
import { hasPermission } from "@/lib/rbac";
import { bucketDrafts } from "@/lib/drafts/triage";

/**
 * Per-membership aggregation used by both the digest mailer and the
 * in-app badge resolver. Counts are computed against live data — there is
 * no separate "open notification" queue. The User's actual outstanding
 * work IS the inbox.
 *
 * What rolls up:
 *   - Open FCG proposals to vote on (FCT/FIRM_ADMIN voters only)
 *   - Open actions (own; overdue split out)
 *   - Drafts owned by the Member, bucketed by FCG deadline (item 65 —
 *     reuses the triage classifier from item 64 so the digest and the
 *     /drafts page agree on what "overdue" / "due soon" mean)
 *   - Sentiment escalations the User owns + acknowledged-pending firm-wide
 *     for FCT (mirroring the existing /sentiment page split)
 *   - Adherence escalations the User owns
 *   - Breach acknowledgements awaiting FIRM_ADMIN
 *   - DPIA / TIA / Terms expiries within 30 days (FCT/FIRM_ADMIN only)
 */

const EXPIRY_WINDOW_DAYS = 30;

export type MembershipDigest = {
  membership: Membership & { user: User };
  tenant: Tenant;
  /** Total unread/outstanding items across every category. */
  totalOpen: number;
  fcgProposals: { open: number; closingSoon: number };
  actions: { open: number; overdue: number };
  /**
   * Item 65 — the Member's own drafts, bucketed by the same FCG-deadline
   * rule as /drafts (item 64). `overdue` + `dueSoon` are the actionable
   * counts; `open` is the no-urgency tail (no deadline, or >24h out) and
   * is deliberately NOT in `totalOpen` so a quiet inbox doesn't trigger
   * a noisy email.
   */
  drafts: { overdue: number; dueSoon: number; open: number };
  sentimentEscalations: { mine: number; firmWideOpen: number };
  adherenceEscalations: { mine: number; firmWideOpen: number };
  breachAcks: { pending: number };
  expiries: {
    dpiaWithin30Days: boolean;
    dpiaDaysUntil: number | null;
    tiasExpiringSoon: number;
    termsExpiringSoon: number;
  };
};

export async function aggregateForMembership(input: {
  tenant: Tenant;
  membership: Membership;
}): Promise<MembershipDigest> {
  const { tenant, membership } = input;
  const tenantId = tenant.id;
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const closingSoonAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const expiryHorizon = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const canVoteOnProposals = hasPermission(membership.role, "fcg:vote");
  const canSeeFirmWideEscalations = hasPermission(membership.role, "members:read");
  const canAckBreach = hasPermission(membership.role, "breach:notify");
  const canSeeExpiries = hasPermission(membership.role, "transfers:read"); // FCT + FIRM_ADMIN
  const canReadTerms = hasPermission(membership.role, "terms:read");

  const user = await superDb.user.findUnique({ where: { id: membership.userId } });
  if (!user) throw new Error(`aggregateForMembership: user ${membership.userId} missing`);

  const [
    openProposals,
    proposalsClosingSoon,
    openActions,
    overdueActions,
    openDrafts,
    mySentimentOpen,
    firmSentimentOpen,
    myAdherenceOpen,
    firmAdherenceOpen,
    pendingBreach,
    dpia,
    tiasExpiringSoon,
    termsExpiringSoon,
  ] = await Promise.all([
    canVoteOnProposals
      ? superDb.fCGProposal.count({
          where: { tenantId, state: "OPEN_FOR_VOTE" },
        })
      : Promise.resolve(0),
    canVoteOnProposals
      ? superDb.fCGProposal.count({
          where: {
            tenantId,
            state: "OPEN_FOR_VOTE",
            votingClosesAt: { lte: closingSoonAt },
          },
        })
      : Promise.resolve(0),
    superDb.action.count({
      where: {
        tenantId,
        membershipId: membership.id,
        status: "OPEN",
      },
    }),
    superDb.action.count({
      where: {
        tenantId,
        membershipId: membership.id,
        status: "OPEN",
        dueAt: { lt: todayStart },
      },
    }),
    // Item 65 — Member's own open drafts, capped (matches /drafts page
    // cap). The bucketer is in lib, not SQL, so we don't push a deadline
    // predicate into the query — that would couple this query to the
    // bucket constants. The cap protects against a runaway Member who
    // has thousands of stale drafts; in practice fewer than a hundred.
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
    superDb.sentimentSignal.count({
      where: {
        tenantId,
        escalatedAt: { not: null },
        acknowledgedAt: null,
        assignedToMembershipId: membership.id,
      },
    }),
    canSeeFirmWideEscalations
      ? superDb.sentimentSignal.count({
          where: {
            tenantId,
            escalatedAt: { not: null },
            acknowledgedAt: null,
          },
        })
      : Promise.resolve(0),
    superDb.communicationAdherence.count({
      where: {
        tenantId,
        escalatedAt: { not: null },
        acknowledgedAt: null,
        membershipId: membership.id,
      },
    }),
    canSeeFirmWideEscalations
      ? superDb.communicationAdherence.count({
          where: {
            tenantId,
            escalatedAt: { not: null },
            acknowledgedAt: null,
          },
        })
      : Promise.resolve(0),
    canAckBreach
      ? superDb.breachClientNotification.count({
          where: {
            tenantId,
            status: "NOTIFIED",
          },
        })
      : Promise.resolve(0),
    canSeeExpiries ? getDpiaStatus(tenantId, now) : Promise.resolve(null),
    canSeeExpiries
      ? superDb.transferImpactAssessment.count({
          where: {
            tenantId,
            status: "RECORDED",
            effectiveTo: { lte: expiryHorizon, gt: now },
          },
        })
      : Promise.resolve(0),
    canReadTerms
      ? superDb.termsRecord.count({
          where: {
            tenantId,
            status: "ACTIVE",
            effectiveTo: { lte: expiryHorizon, gt: now },
          },
        })
      : Promise.resolve(0),
  ]);

  const dpiaWithin30Days =
    dpia !== null &&
    (dpia.state === "EXPIRING_SOON" ||
      dpia.state === "WITHIN_GRACE" ||
      dpia.state === "DEGRADED" ||
      dpia.state === "SCOPE_DRIFT" ||
      dpia.state === "NEVER");
  const dpiaDaysUntil = dpia?.daysUntilExpiry ?? null;

  // Item 65 — bucket on the wall-clock the rest of the aggregator
  // already settled on. The lib is the single source of truth for
  // "what counts as overdue" — see triage.ts for the rule.
  const draftBuckets = bucketDrafts(openDrafts, now);

  const totalOpen =
    openProposals +
    overdueActions +
    draftBuckets.overdue.length +
    draftBuckets.due_soon.length +
    mySentimentOpen +
    myAdherenceOpen +
    pendingBreach +
    (dpiaWithin30Days ? 1 : 0) +
    tiasExpiringSoon +
    termsExpiringSoon;

  return {
    membership: { ...membership, user },
    tenant,
    totalOpen,
    fcgProposals: { open: openProposals, closingSoon: proposalsClosingSoon },
    actions: { open: openActions, overdue: overdueActions },
    drafts: {
      overdue: draftBuckets.overdue.length,
      dueSoon: draftBuckets.due_soon.length,
      open: draftBuckets.open.length,
    },
    sentimentEscalations: {
      mine: mySentimentOpen,
      firmWideOpen: firmSentimentOpen,
    },
    adherenceEscalations: {
      mine: myAdherenceOpen,
      firmWideOpen: firmAdherenceOpen,
    },
    breachAcks: { pending: pendingBreach },
    expiries: {
      dpiaWithin30Days,
      dpiaDaysUntil,
      tiasExpiringSoon,
      termsExpiringSoon,
    },
  };
}

/**
 * Whether there's anything substantive to send. Empty digests are
 * skipped — saves an inbox row + an email for Members with nothing
 * outstanding.
 *
 * Item 65 — drafts contribute via `overdue` + `dueSoon` only. A pile of
 * no-deadline drafts (`open`) is not an FCG-promise breach and shouldn't
 * single-handedly trigger the weekly email; the in-app /drafts page is
 * the surface for that.
 */
export function digestHasContent(d: MembershipDigest): boolean {
  return (
    d.fcgProposals.open > 0 ||
    d.actions.overdue > 0 ||
    d.drafts.overdue > 0 ||
    d.drafts.dueSoon > 0 ||
    d.sentimentEscalations.mine > 0 ||
    d.adherenceEscalations.mine > 0 ||
    d.breachAcks.pending > 0 ||
    d.expiries.dpiaWithin30Days ||
    d.expiries.tiasExpiringSoon > 0 ||
    d.expiries.termsExpiringSoon > 0
  );
}
