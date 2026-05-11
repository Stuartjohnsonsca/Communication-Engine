import {
  Prisma,
  type SubProcessor,
  type SubProcessorChange,
  type SubProcessorChangeKind,
} from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import {
  dispatchSubProcessorChangeAnnounced,
  dispatchSubProcessorChangeCancelled,
  dispatchSubProcessorChangeEffective,
} from "@/lib/notifications/immediate";

/**
 * Sub-processor change lifecycle (post-PRD hardening item 24).
 *
 * Existing §15.3 surface (`src/lib/switching/index.ts`) has immediate
 * `addSubProcessor` / `setSubProcessorActive` / `updateSubProcessor` paths.
 * Those remain for genuine emergencies (security incident → must replace a
 * sub-processor immediately and own the breach of notice obligation
 * separately). The functions here are the recommended workflow: announce,
 * give Clients the notice window, then promote.
 *
 * Lifecycle:
 *   ANNOUNCED → EFFECTIVE   (cron, once effectiveAt elapses; or operator
 *                            "Confirm now" override which writes the same
 *                            audit but with noticeOverride=true)
 *   ANNOUNCED → CANCELLED   (operator aborts at any point before EFFECTIVE)
 *
 * Mutation rules per kind:
 *   ADDED            — creates a SubProcessor with isActive=false alongside
 *                       the change; on EFFECTIVE flips to isActive=true.
 *   REMOVED          — references an existing isActive=true row; on
 *                       EFFECTIVE flips to isActive=false + removedAt=now.
 *   MATERIAL_UPDATE  — references an existing row; on EFFECTIVE writes only
 *                       the audit (operator amends the row directly once
 *                       Clients have been notified).
 */

export const DEFAULT_NOTICE_DAYS = 30;
export const MIN_NOTICE_DAYS = 1;
export const MAX_NOTICE_DAYS = 365;

const ACUMON_TENANT_SLUG = "acumon";

// ─── Inputs ───────────────────────────────────────────────────────────────

export type AnnounceAddedInput = {
  kind: "ADDED";
  description: string;
  effectiveAt: Date;
  subProcessor: {
    code: string;
    name: string;
    role: string;
    jurisdiction: string;
    dataCategories: string[];
    contractRef?: string | null;
    notes?: string | null;
  };
  actorTenantId: string;
  actorMembershipId: string;
};

export type AnnounceExistingInput = {
  kind: "REMOVED" | "MATERIAL_UPDATE";
  description: string;
  effectiveAt: Date;
  subProcessorCode: string;
  actorTenantId: string;
  actorMembershipId: string;
};

export type AnnounceInput = AnnounceAddedInput | AnnounceExistingInput;

// ─── announceChange ────────────────────────────────────────────────────────

export class SubProcessorChangeValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SubProcessorChangeValidationError";
  }
}

function clampEffectiveAt(effectiveAt: Date, now: Date): Date {
  const min = new Date(now.getTime() + MIN_NOTICE_DAYS * 24 * 60 * 60 * 1000);
  const max = new Date(now.getTime() + MAX_NOTICE_DAYS * 24 * 60 * 60 * 1000);
  if (effectiveAt < min) {
    throw new SubProcessorChangeValidationError(
      "effective-too-soon",
      `effectiveAt must be at least ${MIN_NOTICE_DAYS} day(s) from now (DPA-grade notice)`,
    );
  }
  if (effectiveAt > max) {
    throw new SubProcessorChangeValidationError(
      "effective-too-far",
      `effectiveAt must be within ${MAX_NOTICE_DAYS} days from now`,
    );
  }
  return effectiveAt;
}

export type AnnounceResult = {
  change: SubProcessorChange;
  subProcessor: SubProcessor;
  /// Count of Client FIRM_ADMINs notified. Excludes the Acumon tenant.
  notified: number;
};

export async function announceChange(input: AnnounceInput): Promise<AnnounceResult> {
  const now = new Date();
  const effectiveAt = clampEffectiveAt(input.effectiveAt, now);
  const description = input.description.trim();
  if (!description) {
    throw new SubProcessorChangeValidationError(
      "description-required",
      "description is required so Clients understand what is changing and why",
    );
  }

  let subProcessor: SubProcessor;
  if (input.kind === "ADDED") {
    const code = input.subProcessor.code.trim().toLowerCase();
    if (!code) {
      throw new SubProcessorChangeValidationError("code-required", "subprocessor code is required");
    }
    if (!/^[a-z0-9_-]+$/.test(code)) {
      throw new SubProcessorChangeValidationError(
        "code-invalid",
        "code must be lowercase alphanumeric with - or _",
      );
    }
    const existing = await superDb.subProcessor.findUnique({ where: { code } });
    if (existing) {
      throw new SubProcessorChangeValidationError(
        "code-exists",
        `subprocessor ${code} already exists; use REMOVED or MATERIAL_UPDATE instead`,
      );
    }
    const max = await superDb.subProcessor.aggregate({ _max: { ordinal: true } });
    const ordinal = (max._max.ordinal ?? -1) + 1;
    subProcessor = await superDb.subProcessor.create({
      data: {
        code,
        ordinal,
        name: input.subProcessor.name.trim(),
        role: input.subProcessor.role.trim(),
        jurisdiction: input.subProcessor.jurisdiction.trim(),
        dataCategories: input.subProcessor.dataCategories
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
          .slice(0, 30),
        contractRef: input.subProcessor.contractRef?.trim() || null,
        notes: input.subProcessor.notes?.trim() || null,
        isActive: false,
        addedAt: effectiveAt,
      },
    });
  } else {
    const existing = await superDb.subProcessor.findUnique({
      where: { code: input.subProcessorCode },
    });
    if (!existing) {
      throw new SubProcessorChangeValidationError(
        "subprocessor-not-found",
        `subprocessor ${input.subProcessorCode} not found`,
      );
    }
    if (!existing.isActive && input.kind === "REMOVED") {
      throw new SubProcessorChangeValidationError(
        "already-inactive",
        `subprocessor ${input.subProcessorCode} is already inactive`,
      );
    }
    const inFlight = await superDb.subProcessorChange.findFirst({
      where: {
        subProcessorId: existing.id,
        status: "ANNOUNCED",
        kind: input.kind,
      },
    });
    if (inFlight) {
      throw new SubProcessorChangeValidationError(
        "already-announced",
        `a ${input.kind} change for ${input.subProcessorCode} is already announced`,
      );
    }
    subProcessor = existing;
  }

  const change = await superDb.subProcessorChange.create({
    data: {
      subProcessorId: subProcessor.id,
      description,
      kind: input.kind as SubProcessorChangeKind,
      effectiveAt,
      announcedById: input.actorMembershipId,
    },
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "SUBPROCESSOR_CHANGE_ANNOUNCED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "SubProcessorChange",
    subjectId: change.id,
    payload: {
      kind: change.kind,
      subProcessorCode: subProcessor.code,
      subProcessorName: subProcessor.name,
      effectiveAt: change.effectiveAt.toISOString(),
      noticeDays: Math.round(
        (change.effectiveAt.getTime() - change.announcedAt.getTime()) / (24 * 60 * 60 * 1000),
      ),
    },
  });

  let notified = 0;
  try {
    const result = await dispatchSubProcessorChangeAnnounced({
      changeId: change.id,
      kind: change.kind,
      description: change.description,
      effectiveAt: change.effectiveAt,
      subProcessorName: subProcessor.name,
      subProcessorCode: subProcessor.code,
      subProcessorJurisdiction: subProcessor.jurisdiction,
    });
    notified = result.recipients;
  } catch (err) {
    reportError(err, {
      route: "subprocessors/changes#announce",
      extra: { changeId: change.id },
    });
  }

  return { change, subProcessor, notified };
}

// ─── cancelChange ─────────────────────────────────────────────────────────

export type CancelInput = {
  changeId: string;
  reason: string;
  actorTenantId: string;
  actorMembershipId: string;
};

export async function cancelChange(input: CancelInput): Promise<SubProcessorChange> {
  const change = await superDb.subProcessorChange.findUnique({
    where: { id: input.changeId },
    include: { subProcessor: true },
  });
  if (!change) {
    throw new SubProcessorChangeValidationError(
      "change-not-found",
      `change ${input.changeId} not found`,
    );
  }
  if (change.status !== "ANNOUNCED") {
    throw new SubProcessorChangeValidationError(
      "not-announced",
      `change ${input.changeId} is ${change.status}; only ANNOUNCED changes can be cancelled`,
    );
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new SubProcessorChangeValidationError(
      "reason-required",
      "cancellation reason is required",
    );
  }

  const cancelled = await superDb.subProcessorChange.update({
    where: { id: change.id },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledReason: reason,
    },
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "SUBPROCESSOR_CHANGE_CANCELLED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "SubProcessorChange",
    subjectId: change.id,
    payload: {
      kind: change.kind,
      subProcessorCode: change.subProcessor.code,
      reason,
    },
  });

  try {
    await dispatchSubProcessorChangeCancelled({
      changeId: change.id,
      kind: change.kind,
      reason,
      subProcessorName: change.subProcessor.name,
      subProcessorCode: change.subProcessor.code,
    });
  } catch (err) {
    reportError(err, {
      route: "subprocessors/changes#cancel",
      extra: { changeId: change.id },
    });
  }

  return cancelled;
}

// ─── confirmChange (lifecycle promotion) ──────────────────────────────────

export type ConfirmInput = {
  changeId: string;
  /// True when an Acumon operator clicked "Confirm now" before effectiveAt
  /// elapsed. Audited so a notice-period override is forensically visible.
  noticeOverride?: boolean;
  /// Operator membership doing the override. Cron-driven promotions pass
  /// null because there is no human actor.
  actorTenantId?: string | null;
  actorMembershipId?: string | null;
};

export async function confirmChange(
  input: ConfirmInput,
): Promise<SubProcessorChange | null> {
  const change = await superDb.subProcessorChange.findUnique({
    where: { id: input.changeId },
    include: { subProcessor: true },
  });
  if (!change) return null;
  if (change.status !== "ANNOUNCED") {
    // Idempotent: a cron pass that finds the change already EFFECTIVE just
    // returns the current row. Manual "Confirm now" on a CANCELLED change
    // is a no-op too.
    return change;
  }

  const result = await superDb.$transaction(async (tx) => {
    const updated = await tx.subProcessorChange.update({
      where: { id: change.id },
      data: {
        status: "EFFECTIVE",
        confirmedAt: new Date(),
      },
    });
    if (change.kind === "ADDED") {
      await tx.subProcessor.update({
        where: { id: change.subProcessorId },
        data: { isActive: true, addedAt: new Date(), removedAt: null },
      });
    } else if (change.kind === "REMOVED") {
      await tx.subProcessor.update({
        where: { id: change.subProcessorId },
        data: { isActive: false, removedAt: new Date() },
      });
    }
    return updated;
  });

  // Audit lands on the operator tenant chain. For cron-driven promotions,
  // resolve the Acumon tenant id so the row still has a home; the actor
  // membership is null (system actor).
  let auditTenantId = input.actorTenantId ?? null;
  if (!auditTenantId) {
    const acumon = await superDb.tenant.findUnique({
      where: { slug: ACUMON_TENANT_SLUG },
      select: { id: true },
    });
    auditTenantId = acumon?.id ?? null;
  }
  if (auditTenantId) {
    await writeAuditEvent({
      tenantId: auditTenantId,
      eventType: "SUBPROCESSOR_CHANGE_EFFECTIVE",
      actorMembershipId: input.actorMembershipId ?? null,
      subjectType: "SubProcessorChange",
      subjectId: change.id,
      payload: {
        kind: change.kind,
        subProcessorCode: change.subProcessor.code,
        subProcessorName: change.subProcessor.name,
        noticeOverride: !!input.noticeOverride,
        announcedAt: change.announcedAt.toISOString(),
        effectiveAt: change.effectiveAt.toISOString(),
      } as Prisma.InputJsonValue,
    });
  }

  try {
    await dispatchSubProcessorChangeEffective({
      changeId: change.id,
      kind: change.kind,
      subProcessorName: change.subProcessor.name,
      subProcessorCode: change.subProcessor.code,
      effectiveAt: change.effectiveAt,
      noticeOverride: !!input.noticeOverride,
    });
  } catch (err) {
    reportError(err, {
      route: "subprocessors/changes#confirm",
      extra: { changeId: change.id },
    });
  }

  return result;
}

// ─── Cron worker: auto-confirm due changes ────────────────────────────────

export async function processDueChanges(now: Date = new Date()): Promise<{
  considered: number;
  confirmed: number;
}> {
  const due = await superDb.subProcessorChange.findMany({
    where: { status: "ANNOUNCED", effectiveAt: { lte: now } },
    orderBy: { effectiveAt: "asc" },
    take: 200,
  });
  let confirmed = 0;
  for (const c of due) {
    const result = await confirmChange({ changeId: c.id });
    if (result && result.status === "EFFECTIVE") confirmed += 1;
  }
  return { considered: due.length, confirmed };
}

// ─── Reads ────────────────────────────────────────────────────────────────

export type ChangeWithSubProcessor = SubProcessorChange & {
  subProcessor: SubProcessor;
};

export async function listPendingChanges(): Promise<ChangeWithSubProcessor[]> {
  return superDb.subProcessorChange.findMany({
    where: { status: "ANNOUNCED" },
    include: { subProcessor: true },
    orderBy: { effectiveAt: "asc" },
  });
}

export async function listRecentChanges(limit = 20): Promise<ChangeWithSubProcessor[]> {
  return superDb.subProcessorChange.findMany({
    include: { subProcessor: true },
    orderBy: { announcedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
  });
}

export async function getChange(id: string): Promise<ChangeWithSubProcessor | null> {
  return superDb.subProcessorChange.findUnique({
    where: { id },
    include: { subProcessor: true },
  });
}
