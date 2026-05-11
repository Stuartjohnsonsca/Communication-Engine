import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { eraseUser, type EraseUserResult, UserErasureError } from "./erasure";
import { reportError } from "@/lib/observability";

/**
 * DSAR open/fulfil lifecycle (PRD §12.4).
 *
 * Standard turnaround is 14 calendar days; statutory backstop is 1 calendar
 * month (extendable per UK GDPR Art. 12). We default `dueAt` to opened+14d
 * and surface an `overdueOf30d` badge in the list view to flag the backstop
 * crossing.
 */

export const STANDARD_TURNAROUND_DAYS = 14;
export const STATUTORY_BACKSTOP_DAYS = 30;

export type DsarKind = "ACCESS" | "RECTIFY" | "ERASE" | "RESTRICT" | "PORT" | "OBJECT";
export type DsarSubjectType = "USER" | "COUNTERPARTY";

const ALLOWED_KINDS: DsarKind[] = ["ACCESS", "RECTIFY", "ERASE", "RESTRICT", "PORT", "OBJECT"];
const ALLOWED_SUBJECTS: DsarSubjectType[] = ["USER", "COUNTERPARTY"];

export type OpenDsarInput = {
  tenantId: string;
  actorMembershipId: string;
  subjectType: DsarSubjectType;
  subjectIdent: string;
  kind: DsarKind;
};

export async function openDsar(input: OpenDsarInput) {
  if (!ALLOWED_SUBJECTS.includes(input.subjectType)) {
    throw new Error(`DSAR: invalid subjectType ${input.subjectType}`);
  }
  if (!ALLOWED_KINDS.includes(input.kind)) {
    throw new Error(`DSAR: invalid kind ${input.kind}`);
  }
  const ident = input.subjectIdent.trim();
  if (!ident) throw new Error("DSAR: subjectIdent required");

  const openedAt = new Date();
  const dueAt = new Date(openedAt);
  dueAt.setUTCDate(dueAt.getUTCDate() + STANDARD_TURNAROUND_DAYS);

  const dsar = await superDb.dSARequest.create({
    data: {
      tenantId: input.tenantId,
      subjectType: input.subjectType,
      subjectIdent: ident,
      kind: input.kind,
      status: "OPEN",
      openedAt,
      dueAt,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "DSAR_OPENED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "DSARequest",
    subjectId: dsar.id,
    payload: {
      subjectType: input.subjectType,
      subjectIdent: ident,
      kind: input.kind,
      dueAt: dueAt.toISOString(),
    },
  });

  return dsar;
}

export type FulfillDsarInput = {
  tenantId: string;
  dsarId: string;
  actorMembershipId: string;
  packageRef?: string | null;
  outcome: "FULFILLED" | "REJECTED";
  notes?: string | null;
};

export type FulfillDsarOutcome = {
  request: Awaited<ReturnType<typeof superDb.dSARequest.update>>;
  /** Populated when the DSAR was kind=ERASE + subjectType=USER and
   *  fulfilment triggered cross-tenant pseudonymisation. */
  erasure: EraseUserResult | null;
};

export async function fulfillDsar(input: FulfillDsarInput): Promise<FulfillDsarOutcome> {
  const existing = await superDb.dSARequest.findFirst({
    where: { id: input.dsarId, tenantId: input.tenantId },
  });
  if (!existing) throw new Error("DSAR: not found in tenant");
  if (existing.fulfilledAt) throw new Error("DSAR: already fulfilled");

  const fulfilledAt = new Date();

  // Erase-side execution runs BEFORE the DSARequest row flips to
  // FULFILLED. Two reasons: (a) if the User can't be resolved (typo in
  // subjectIdent, account already removed by some other path), surfacing
  // the error before stamping FULFILLED lets the operator decide what to
  // do; (b) the audit chain reads cleaner when USER_ERASED lands before
  // DSAR_FULFILLED — the cause precedes its closure event. REJECT
  // outcomes skip the erasure (the operator decided not to act).
  let erasure: EraseUserResult | null = null;
  if (
    input.outcome === "FULFILLED" &&
    existing.kind === "ERASE" &&
    existing.subjectType === "USER"
  ) {
    const user = await superDb.user.findFirst({
      where: { email: existing.subjectIdent.trim().toLowerCase() },
    });
    if (!user) {
      throw new UserErasureError(
        "user-not-found",
        `DSAR fulfilment: User with email ${existing.subjectIdent} not found`,
      );
    }
    try {
      erasure = await eraseUser({
        userId: user.id,
        requestingTenantId: input.tenantId,
        actorMembershipId: input.actorMembershipId,
        dsarRequestId: existing.id,
        reason: input.notes ?? null,
      });
    } catch (err) {
      // Erasure is the load-bearing side-effect; if it fails, refuse to
      // stamp FULFILLED so the operator can investigate without a
      // misleading "we did it" audit row.
      reportError(err, {
        route: "dsar/fulfill",
        tenantId: input.tenantId,
        extra: { dsarId: existing.id },
      });
      throw err;
    }
  }

  const updated = await superDb.dSARequest.update({
    where: { id: existing.id },
    data: {
      status: input.outcome,
      fulfilledAt,
      packageRef: input.packageRef?.trim() || existing.packageRef,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "DSAR_FULFILLED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "DSARequest",
    subjectId: updated.id,
    payload: {
      outcome: input.outcome,
      packageRef: updated.packageRef ?? null,
      notes: input.notes ?? null,
      fulfilledAt: fulfilledAt.toISOString(),
      durationDays: Math.round(
        (fulfilledAt.getTime() - existing.openedAt.getTime()) / (24 * 60 * 60 * 1000),
      ),
      withinStandard:
        fulfilledAt.getTime() - existing.openedAt.getTime() <=
        STANDARD_TURNAROUND_DAYS * 24 * 60 * 60 * 1000,
      erasure: erasure
        ? {
            userId: erasure.userId,
            alreadyErased: erasure.alreadyErased,
            tenantIdsAffected: erasure.tenantIdsAffected,
            membershipsAnonymised: erasure.membershipsAnonymised,
            ucgsAnonymised: erasure.ucgsAnonymised,
            sessionsRevoked: erasure.sessionsRevoked,
            channelAuthsDeleted: erasure.channelAuthsDeleted,
            totpWiped: erasure.totpWiped,
          }
        : null,
    },
  });

  return { request: updated, erasure };
}

export type DsarSlaBadge =
  | { kind: "in_window"; daysLeft: number }
  | { kind: "due_soon"; daysLeft: number }
  | { kind: "overdue_standard"; daysOver: number }
  | { kind: "overdue_backstop"; daysOver: number }
  | { kind: "fulfilled"; durationDays: number; withinStandard: boolean }
  | { kind: "rejected" };

export function computeSlaBadge(
  d: { openedAt: Date; dueAt: Date | null; fulfilledAt: Date | null; status: string },
  now: Date = new Date(),
): DsarSlaBadge {
  if (d.status === "REJECTED") return { kind: "rejected" };
  if (d.fulfilledAt) {
    const ms = d.fulfilledAt.getTime() - d.openedAt.getTime();
    return {
      kind: "fulfilled",
      durationDays: Math.round(ms / (24 * 60 * 60 * 1000)),
      withinStandard: ms <= STANDARD_TURNAROUND_DAYS * 24 * 60 * 60 * 1000,
    };
  }
  const dueAt =
    d.dueAt ??
    new Date(d.openedAt.getTime() + STANDARD_TURNAROUND_DAYS * 24 * 60 * 60 * 1000);
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((dueAt.getTime() - now.getTime()) / msPerDay);
  if (diffDays < 0) {
    const daysOver = -diffDays;
    const backstopAt = new Date(d.openedAt.getTime() + STATUTORY_BACKSTOP_DAYS * msPerDay);
    if (now.getTime() > backstopAt.getTime()) {
      return {
        kind: "overdue_backstop",
        daysOver: Math.round((now.getTime() - backstopAt.getTime()) / msPerDay),
      };
    }
    return { kind: "overdue_standard", daysOver };
  }
  if (diffDays <= 3) return { kind: "due_soon", daysLeft: diffDays };
  return { kind: "in_window", daysLeft: diffDays };
}
