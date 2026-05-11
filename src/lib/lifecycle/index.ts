import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import type { Membership, UserCultureGuide } from "@prisma/client";

/**
 * User lifecycle (PRD §14.3).
 *
 * Two transitions with material processing consequences live here:
 *
 *  1. User-initiated revocation. The User pulls source-system access from
 *     /account. Drafting halts immediately; the UCG is FROZEN; channel
 *     authorisations are revoked. A 30-day grace window starts. If the User
 *     re-authorises within the window the lifecycle returns to ACTIVE; if
 *     not, the sweep flips Membership.status → SUSPENDED and anonymises
 *     the UCG.
 *
 *  2. Firm-Admin-initiated leaver. The admin marks a member as a leaver in
 *     the lifecycle console. Membership.status flips to LEAVER_FROZEN
 *     immediately, channels are revoked and the UCG is FROZEN. After 30
 *     calendar days the sweep flips Membership.status → ANONYMISED and
 *     anonymises the UCG. The 12-month performance-record anonymisation
 *     (PRD §14.3) is a separate sweep handled by the adherence module.
 *
 * Joiner and Mover are covered by the existing FCG/UCG flows and the
 * /admin/members page; this module is concerned with revocation and
 * departure only.
 */

const GRACE_DAYS_REVOKE = 30;
const GRACE_DAYS_LEAVER = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function plusDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

export type LifecycleState =
  | { kind: "active" }
  | { kind: "revoked_grace"; revokedAt: Date; deadline: Date; daysLeft: number }
  | { kind: "revoked_expired"; revokedAt: Date; deadline: Date }
  | { kind: "leaver_grace"; markedAt: Date; deadline: Date; daysLeft: number }
  | { kind: "leaver_expired"; markedAt: Date; deadline: Date }
  | { kind: "suspended"; revokedAt: Date | null }
  | { kind: "anonymised"; anonymisedAt: Date }
  | { kind: "invited" }
  | { kind: "other"; status: string };

export function getMemberLifecycleState(
  m: Pick<
    Membership,
    | "status"
    | "accessRevokedAt"
    | "reauthDeadlineAt"
    | "leaverMarkedAt"
    | "anonymiseDueAt"
    | "anonymisedAt"
  >,
  now: Date = new Date(),
): LifecycleState {
  if (m.status === "ANONYMISED") {
    return { kind: "anonymised", anonymisedAt: m.anonymisedAt ?? now };
  }
  if (m.status === "SUSPENDED") {
    return { kind: "suspended", revokedAt: m.accessRevokedAt };
  }
  if (m.status === "LEAVER_FROZEN") {
    const markedAt = m.leaverMarkedAt ?? now;
    const deadline = m.anonymiseDueAt ?? plusDays(markedAt, GRACE_DAYS_LEAVER);
    if (now.getTime() >= deadline.getTime()) {
      return { kind: "leaver_expired", markedAt, deadline };
    }
    return {
      kind: "leaver_grace",
      markedAt,
      deadline,
      daysLeft: Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / MS_PER_DAY)),
    };
  }
  if (m.status === "INVITED") return { kind: "invited" };
  if (m.accessRevokedAt) {
    const deadline = m.reauthDeadlineAt ?? plusDays(m.accessRevokedAt, GRACE_DAYS_REVOKE);
    if (now.getTime() >= deadline.getTime()) {
      return { kind: "revoked_expired", revokedAt: m.accessRevokedAt, deadline };
    }
    return {
      kind: "revoked_grace",
      revokedAt: m.accessRevokedAt,
      deadline,
      daysLeft: Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / MS_PER_DAY)),
    };
  }
  if (m.status === "ACTIVE") return { kind: "active" };
  return { kind: "other", status: m.status };
}

export function isDraftingPermitted(state: LifecycleState): boolean {
  return state.kind === "active";
}

// ─── User-initiated revocation ─────────────────────────────────────────────

export type RevokeAccessInput = {
  tenantId: string;
  membershipId: string;
  /** Optional — when null, this was a self-serve revoke with no surrogate actor. */
  actorMembershipId?: string | null;
  /** Free-form note shown to admin/FCT in the lifecycle console. */
  note?: string | null;
};

export async function revokeAccess(input: RevokeAccessInput) {
  const member = await superDb.membership.findFirst({
    where: { id: input.membershipId, tenantId: input.tenantId },
  });
  if (!member) throw new Error("lifecycle: membership not found in tenant");
  if (member.accessRevokedAt) {
    return { membership: member, alreadyRevoked: true as const };
  }
  if (member.status !== "ACTIVE") {
    throw new Error(`lifecycle: cannot revoke from status ${member.status}`);
  }

  const now = new Date();
  const deadline = plusDays(now, GRACE_DAYS_REVOKE);

  const updated = await superDb.$transaction(async (tx) => {
    const m = await tx.membership.update({
      where: { id: member.id },
      data: {
        accessRevokedAt: now,
        reauthDeadlineAt: deadline,
        lifecycleNotes: input.note?.trim() || member.lifecycleNotes,
      },
    });
    await tx.channelAuth.updateMany({
      where: { tenantId: input.tenantId, membershipId: member.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.userCultureGuide.updateMany({
      where: {
        tenantId: input.tenantId,
        membershipId: member.id,
        status: { in: ["COMMITTED", "CONFLICTED"] },
      },
      data: { status: "FROZEN", frozenAt: now },
    });
    return m;
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "USER_ACCESS_REVOKED",
    actorMembershipId: input.actorMembershipId ?? member.id,
    subjectType: "Membership",
    subjectId: member.id,
    payload: {
      revokedAt: now.toISOString(),
      reauthDeadlineAt: deadline.toISOString(),
      selfServe: !input.actorMembershipId || input.actorMembershipId === member.id,
    },
  });
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "UCG_FROZEN",
    actorMembershipId: input.actorMembershipId ?? member.id,
    subjectType: "Membership",
    subjectId: member.id,
    payload: { reason: "access_revoked" },
  });

  return { membership: updated, alreadyRevoked: false as const };
}

export type ReauthoriseInput = {
  tenantId: string;
  membershipId: string;
  actorMembershipId?: string | null;
};

export async function reauthoriseAccess(input: ReauthoriseInput) {
  const member = await superDb.membership.findFirst({
    where: { id: input.membershipId, tenantId: input.tenantId },
  });
  if (!member) throw new Error("lifecycle: membership not found in tenant");
  if (!member.accessRevokedAt) return { membership: member, alreadyActive: true as const };
  if (member.status !== "ACTIVE") {
    throw new Error(`lifecycle: cannot re-authorise from status ${member.status}`);
  }

  const updated = await superDb.$transaction(async (tx) => {
    const m = await tx.membership.update({
      where: { id: member.id },
      data: { accessRevokedAt: null, reauthDeadlineAt: null },
    });
    // Restore the most recent committed-or-conflicted UCG that we froze on
    // revocation. We only flip rows we ourselves froze (frozenAt is set);
    // anonymised rows are not eligible.
    await tx.userCultureGuide.updateMany({
      where: {
        tenantId: input.tenantId,
        membershipId: member.id,
        status: "FROZEN",
        anonymisedAt: null,
      },
      data: { status: "COMMITTED", frozenAt: null },
    });
    return m;
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "USER_REAUTHORISED",
    actorMembershipId: input.actorMembershipId ?? member.id,
    subjectType: "Membership",
    subjectId: member.id,
    payload: { reauthorisedAt: new Date().toISOString() },
  });

  return { membership: updated, alreadyActive: false as const };
}

// ─── Firm-Admin-initiated leaver flow ──────────────────────────────────────

export type MarkLeaverInput = {
  tenantId: string;
  membershipId: string;
  actorMembershipId: string;
  note?: string | null;
};

export async function markLeaver(input: MarkLeaverInput) {
  const member = await superDb.membership.findFirst({
    where: { id: input.membershipId, tenantId: input.tenantId },
  });
  if (!member) throw new Error("lifecycle: membership not found in tenant");
  if (member.status === "LEAVER_FROZEN") {
    return { membership: member, alreadyLeaver: true as const };
  }
  if (member.status === "ANONYMISED") {
    throw new Error("lifecycle: membership is already anonymised");
  }

  const now = new Date();
  const deadline = plusDays(now, GRACE_DAYS_LEAVER);

  const updated = await superDb.$transaction(async (tx) => {
    const m = await tx.membership.update({
      where: { id: member.id },
      data: {
        status: "LEAVER_FROZEN",
        leaverMarkedAt: now,
        anonymiseDueAt: deadline,
        leftAt: now,
        // Clear any in-flight revocation state — leaver supersedes.
        accessRevokedAt: null,
        reauthDeadlineAt: null,
        lifecycleNotes: input.note?.trim() || member.lifecycleNotes,
      },
    });
    await tx.channelAuth.updateMany({
      where: { tenantId: input.tenantId, membershipId: member.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.userCultureGuide.updateMany({
      where: {
        tenantId: input.tenantId,
        membershipId: member.id,
        status: { in: ["COMMITTED", "CONFLICTED"] },
      },
      data: { status: "FROZEN", frozenAt: now },
    });
    return m;
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "USER_MARKED_LEAVER",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Membership",
    subjectId: member.id,
    payload: {
      markedAt: now.toISOString(),
      anonymiseDueAt: deadline.toISOString(),
      note: input.note ?? null,
    },
  });
  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "UCG_FROZEN",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Membership",
    subjectId: member.id,
    payload: { reason: "leaver_marked" },
  });

  return { membership: updated, alreadyLeaver: false as const };
}

export type ReverseLeaverInput = {
  tenantId: string;
  membershipId: string;
  actorMembershipId: string;
  reason: string;
};

export async function reverseLeaver(input: ReverseLeaverInput) {
  const member = await superDb.membership.findFirst({
    where: { id: input.membershipId, tenantId: input.tenantId },
  });
  if (!member) throw new Error("lifecycle: membership not found in tenant");
  if (member.status !== "LEAVER_FROZEN") {
    throw new Error(`lifecycle: cannot reverse leaver from status ${member.status}`);
  }
  if (member.anonymisedAt) {
    throw new Error("lifecycle: membership already anonymised");
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error("lifecycle: reason required to reverse leaver");

  const updated = await superDb.$transaction(async (tx) => {
    const m = await tx.membership.update({
      where: { id: member.id },
      data: {
        status: "ACTIVE",
        leaverMarkedAt: null,
        anonymiseDueAt: null,
        leftAt: null,
      },
    });
    await tx.userCultureGuide.updateMany({
      where: {
        tenantId: input.tenantId,
        membershipId: member.id,
        status: "FROZEN",
        anonymisedAt: null,
      },
      data: { status: "COMMITTED", frozenAt: null },
    });
    return m;
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "USER_LEAVER_REVERSED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Membership",
    subjectId: member.id,
    payload: { reason, reversedAt: new Date().toISOString() },
  });

  return { membership: updated };
}

// ─── Sweep / time-based transitions ────────────────────────────────────────

export async function anonymiseUcgsFor(tenantId: string, membershipId: string) {
  const ucgs = await superDb.userCultureGuide.findMany({
    where: { tenantId, membershipId, anonymisedAt: null },
    select: { id: true },
  });
  if (ucgs.length === 0) return [] as UserCultureGuide["id"][];
  const ids = ucgs.map((u) => u.id);
  const now = new Date();
  await superDb.$transaction([
    superDb.uCGRule.deleteMany({ where: { ucgId: { in: ids } } }),
    superDb.userCultureGuide.updateMany({
      where: { id: { in: ids } },
      data: { status: "ANONYMISED", anonymisedAt: now },
    }),
  ]);
  // updateMany cannot set a Json column to NULL via the typed API; use a
  // raw NULL pass to drop the saved signature block.
  await superDb.$executeRawUnsafe(
    `UPDATE "UserCultureGuide" SET "signatureBlock" = NULL WHERE "id" = ANY($1::text[])`,
    ids,
  );
  return ids;
}

export type LifecycleSweepResult = {
  revokedExpired: number;
  leaverExpired: number;
  ucgsAnonymised: number;
};

export async function runLifecycleSweep({
  tenantId,
  now = new Date(),
}: {
  tenantId?: string;
  now?: Date;
} = {}): Promise<LifecycleSweepResult> {
  const tenantFilter = tenantId ? { tenantId } : {};
  let revokedExpired = 0;
  let leaverExpired = 0;
  let ucgsAnonymised = 0;

  // 1) Revocation grace expired → SUSPENDED + UCG anonymised.
  const revokedDue = await superDb.membership.findMany({
    where: {
      ...tenantFilter,
      status: "ACTIVE",
      accessRevokedAt: { not: null },
      reauthDeadlineAt: { lte: now },
    },
  });
  for (const m of revokedDue) {
    await superDb.membership.update({
      where: { id: m.id },
      data: { status: "SUSPENDED", anonymisedAt: now },
    });
    const ids = await anonymiseUcgsFor(m.tenantId, m.id);
    ucgsAnonymised += ids.length;
    revokedExpired += 1;
    await writeAuditEvent({
      tenantId: m.tenantId,
      eventType: "MEMBERSHIP_SUSPENDED_AFTER_GRACE",
      actorMembershipId: null,
      subjectType: "Membership",
      subjectId: m.id,
      payload: {
        revokedAt: m.accessRevokedAt?.toISOString() ?? null,
        deadlineAt: m.reauthDeadlineAt?.toISOString() ?? null,
        ucgsAnonymised: ids.length,
      },
    });
    if (ids.length > 0) {
      await writeAuditEvent({
        tenantId: m.tenantId,
        eventType: "UCG_ANONYMISED",
        actorMembershipId: null,
        subjectType: "Membership",
        subjectId: m.id,
        payload: { reason: "grace_expired_after_revocation", ucgIds: ids },
      });
    }
  }

  // 2) Leaver grace expired → ANONYMISED + UCG anonymised.
  const leaverDue = await superDb.membership.findMany({
    where: {
      ...tenantFilter,
      status: "LEAVER_FROZEN",
      anonymiseDueAt: { lte: now },
    },
  });
  for (const m of leaverDue) {
    await superDb.membership.update({
      where: { id: m.id },
      data: { status: "ANONYMISED", anonymisedAt: now },
    });
    const ids = await anonymiseUcgsFor(m.tenantId, m.id);
    ucgsAnonymised += ids.length;
    leaverExpired += 1;
    await writeAuditEvent({
      tenantId: m.tenantId,
      eventType: "MEMBERSHIP_ANONYMISED",
      actorMembershipId: null,
      subjectType: "Membership",
      subjectId: m.id,
      payload: {
        markedAt: m.leaverMarkedAt?.toISOString() ?? null,
        deadlineAt: m.anonymiseDueAt?.toISOString() ?? null,
        ucgsAnonymised: ids.length,
      },
    });
    if (ids.length > 0) {
      await writeAuditEvent({
        tenantId: m.tenantId,
        eventType: "UCG_ANONYMISED",
        actorMembershipId: null,
        subjectType: "Membership",
        subjectId: m.id,
        payload: { reason: "leaver_grace_expired", ucgIds: ids },
      });
    }
  }

  return { revokedExpired, leaverExpired, ucgsAnonymised };
}
