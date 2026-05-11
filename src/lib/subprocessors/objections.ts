import type { SubProcessorObjection } from "@prisma/client";
import { superDb, tenantDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Per-tenant objections to an announced sub-processor change. Logged on
 * the Client's audit chain and surfaced to Acumon operators reviewing
 * the change. Objections are non-blocking by design — Acumon can proceed,
 * but the lodged record is the legal evidence that the Client objected
 * within the notice window (DPA art. 28(2)(a)).
 */

export class ObjectionValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ObjectionValidationError";
  }
}

export type RaiseInput = {
  tenantId: string;
  subProcessorChangeId: string;
  raisedByMembershipId: string;
  reason: string;
};

export async function raiseObjection(input: RaiseInput): Promise<SubProcessorObjection> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ObjectionValidationError(
      "reason-required",
      "objection reason is required so Acumon understands the concern",
    );
  }

  // The change is a global row — read via superDb.
  const change = await superDb.subProcessorChange.findUnique({
    where: { id: input.subProcessorChangeId },
  });
  if (!change) {
    throw new ObjectionValidationError(
      "change-not-found",
      `change ${input.subProcessorChangeId} not found`,
    );
  }
  if (change.status !== "ANNOUNCED") {
    throw new ObjectionValidationError(
      "change-closed",
      `objections can only be raised against ANNOUNCED changes; this change is ${change.status}`,
    );
  }

  const existing = await superDb.subProcessorObjection.findUnique({
    where: {
      tenantId_subProcessorChangeId: {
        tenantId: input.tenantId,
        subProcessorChangeId: input.subProcessorChangeId,
      },
    },
  });
  if (existing) {
    // If previously withdrawn, allow re-raising by clearing the withdrawal.
    if (existing.withdrawnAt) {
      const refreshed = await superDb.subProcessorObjection.update({
        where: { id: existing.id },
        data: {
          reason,
          raisedAt: new Date(),
          raisedById: input.raisedByMembershipId,
          withdrawnAt: null,
          withdrawnReason: null,
        },
      });
      await writeAuditEvent({
        tenantId: input.tenantId,
        eventType: "SUBPROCESSOR_OBJECTION_RAISED",
        actorMembershipId: input.raisedByMembershipId,
        subjectType: "SubProcessorObjection",
        subjectId: refreshed.id,
        payload: {
          changeId: input.subProcessorChangeId,
          reraised: true,
        },
      });
      return refreshed;
    }
    throw new ObjectionValidationError(
      "already-raised",
      "this tenant has already raised an objection to this change",
    );
  }

  // Write under tenant context so RLS double-binds the insert.
  const created = await tenantDb(input.tenantId).subProcessorObjection.create({
    data: {
      tenantId: input.tenantId,
      subProcessorChangeId: input.subProcessorChangeId,
      raisedById: input.raisedByMembershipId,
      reason,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "SUBPROCESSOR_OBJECTION_RAISED",
    actorMembershipId: input.raisedByMembershipId,
    subjectType: "SubProcessorObjection",
    subjectId: created.id,
    payload: {
      changeId: input.subProcessorChangeId,
      reraised: false,
    },
  });

  return created;
}

export type WithdrawInput = {
  tenantId: string;
  objectionId: string;
  withdrawnByMembershipId: string;
  reason?: string | null;
};

export async function withdrawObjection(input: WithdrawInput): Promise<SubProcessorObjection> {
  const objection = await tenantDb(input.tenantId).subProcessorObjection.findUnique({
    where: { id: input.objectionId },
  });
  if (!objection) {
    throw new ObjectionValidationError(
      "objection-not-found",
      `objection ${input.objectionId} not found`,
    );
  }
  if (objection.withdrawnAt) {
    return objection; // idempotent
  }

  const reason = input.reason?.trim() || null;
  const updated = await tenantDb(input.tenantId).subProcessorObjection.update({
    where: { id: objection.id },
    data: { withdrawnAt: new Date(), withdrawnReason: reason },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "SUBPROCESSOR_OBJECTION_WITHDRAWN",
    actorMembershipId: input.withdrawnByMembershipId,
    subjectType: "SubProcessorObjection",
    subjectId: objection.id,
    payload: {
      changeId: objection.subProcessorChangeId,
      hasReason: !!reason,
    },
  });

  return updated;
}

// ─── Reads ────────────────────────────────────────────────────────────────

export async function getObjectionForTenant(
  tenantId: string,
  subProcessorChangeId: string,
): Promise<SubProcessorObjection | null> {
  return tenantDb(tenantId).subProcessorObjection.findUnique({
    where: {
      tenantId_subProcessorChangeId: { tenantId, subProcessorChangeId },
    },
  });
}

/**
 * Acumon-operator-side read of every objection raised against a given
 * change. Uses superDb because the operator legitimately needs to see
 * objections from all Client tenants. Audit chains stay tenant-scoped;
 * this is the cross-tenant reviewer surface.
 */
export async function listObjectionsForChange(
  subProcessorChangeId: string,
): Promise<SubProcessorObjection[]> {
  return superDb.subProcessorObjection.findMany({
    where: { subProcessorChangeId, withdrawnAt: null },
    orderBy: { raisedAt: "asc" },
  });
}
