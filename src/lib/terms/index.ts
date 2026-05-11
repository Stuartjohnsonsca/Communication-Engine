import type { Prisma, TermsKind, TermsRecord, TermsStatus } from "@prisma/client";
import { tenantDb, superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from "@/lib/api-errors";

/**
 * PRD §15.4 Terms and Conditions persistence.
 *
 * Per-tenant, versioned terms records: MSA, DPA, AUP, SLA. (The Sub-
 * Processor List is a global surface under §15.3 — it is intentionally
 * not modelled here.)
 *
 * Lifecycle:
 *   DRAFT      — staged but not in force.
 *   ACTIVE     — current effective version. At most one ACTIVE per (tenant,
 *                kind); activating a new version automatically supersedes
 *                the previous ACTIVE.
 *   SUPERSEDED — older versions, retained for audit + DSAR per §12.5.
 *
 * Tenant scoping: queries go through `tenantDb()` so RLS enforces row
 * isolation in addition to WHERE clauses. Audit events are written to the
 * tenant's own chain.
 *
 * §12.5 retention: TermsRecord is excluded from `runHardDeletionSweep`
 * (see `src/lib/termination/index.ts`) so the records survive non-renewal,
 * matching the PRD wording "persistent until changed".
 */

const KINDS: TermsKind[] = ["MSA", "DPA", "AUP", "SLA"];
const MAX_BODY = 200_000;
const MAX_DOC_REF = 1_000;

export type TermsView = {
  /** ACTIVE record per kind, or null. */
  active: Record<TermsKind, TermsRecord | null>;
  /** Full history per kind, newest first. */
  history: Record<TermsKind, TermsRecord[]>;
};

export async function getTermsView(tenantId: string): Promise<TermsView> {
  const db = tenantDb(tenantId);
  const all = await db.termsRecord.findMany({
    orderBy: [{ kind: "asc" }, { version: "desc" }],
  });
  const active: Record<TermsKind, TermsRecord | null> = {
    MSA: null,
    DPA: null,
    AUP: null,
    SLA: null,
  };
  const history: Record<TermsKind, TermsRecord[]> = {
    MSA: [],
    DPA: [],
    AUP: [],
    SLA: [],
  };
  for (const r of all) {
    history[r.kind].push(r);
    if (r.status === "ACTIVE" && !active[r.kind]) active[r.kind] = r;
  }
  return { active, history };
}

// ─── Mutations ────────────────────────────────────────────────────────────

export type RecordTermsInput = {
  tenantId: string;
  kind: TermsKind;
  documentRef: string;
  body: string;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  signedByName?: string | null;
  signedByRole?: string | null;
  signedAt?: Date | null;
  countersignedByName?: string | null;
  countersignedAt?: Date | null;
  notes?: string | null;
  /** Activate immediately (default: false — record is staged DRAFT). */
  activate?: boolean;
  actorMembershipId: string;
};

export async function recordTerms(input: RecordTermsInput): Promise<TermsRecord> {
  await assertMembership(input.actorMembershipId, input.tenantId);
  if (!KINDS.includes(input.kind))
    throw new ValidationError(`terms: unknown kind ${input.kind}`, "unknown-kind");
  if (!input.documentRef.trim())
    throw new ValidationError("terms: documentRef is required", "document-ref-required");
  if (!input.body.trim())
    throw new ValidationError("terms: body is required", "body-required");
  if (input.documentRef.length > MAX_DOC_REF) {
    throw new ValidationError("terms: documentRef exceeds limit", "document-ref-too-long");
  }
  if (Buffer.byteLength(input.body, "utf8") > MAX_BODY) {
    throw new ValidationError("terms: body exceeds size limit", "body-too-long");
  }

  const db = tenantDb(input.tenantId);
  const max = await db.termsRecord.aggregate({
    where: { kind: input.kind },
    _max: { version: true },
  });
  const version = (max._max.version ?? 0) + 1;

  const created = await db.termsRecord.create({
    data: {
      tenantId: input.tenantId,
      kind: input.kind,
      version,
      status: input.activate ? "ACTIVE" : "DRAFT",
      documentRef: input.documentRef.trim(),
      body: input.body.trim(),
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      signedByName: input.signedByName?.trim() || null,
      signedByRole: input.signedByRole?.trim() || null,
      signedAt: input.signedAt ?? null,
      countersignedByName: input.countersignedByName?.trim() || null,
      countersignedAt: input.countersignedAt ?? null,
      notes: input.notes?.trim() || null,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "TERMS_RECORDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "TermsRecord",
    subjectId: created.id,
    payload: {
      kind: input.kind,
      version,
      activated: !!input.activate,
      hasSignature: !!input.signedByName?.trim(),
    },
  });

  if (input.activate) {
    await applyActivation({
      tenantId: input.tenantId,
      record: created,
      actorMembershipId: input.actorMembershipId,
    });
  }

  return created;
}

export type ActivateTermsInput = {
  tenantId: string;
  recordId: string;
  actorMembershipId: string;
};

export async function activateTerms(input: ActivateTermsInput): Promise<TermsRecord> {
  await assertMembership(input.actorMembershipId, input.tenantId);

  const db = tenantDb(input.tenantId);
  const record = await db.termsRecord.findUnique({ where: { id: input.recordId } });
  if (!record) throw new NotFoundError("terms: record not found", "record-not-found");
  if (record.status === "ACTIVE") return record;
  if (record.status === "SUPERSEDED") {
    throw new ConflictError(
      "terms: cannot reactivate a superseded version — record a new one",
      "superseded-cannot-reactivate",
    );
  }

  const updated = await db.termsRecord.update({
    where: { id: record.id },
    data: { status: "ACTIVE" },
  });

  await applyActivation({
    tenantId: input.tenantId,
    record: updated,
    actorMembershipId: input.actorMembershipId,
  });

  return updated;
}

export type AmendTermsInput = {
  tenantId: string;
  recordId: string;
  body?: string;
  documentRef?: string;
  notes?: string | null;
  signedByName?: string | null;
  signedByRole?: string | null;
  signedAt?: Date | null;
  countersignedByName?: string | null;
  countersignedAt?: Date | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  actorMembershipId: string;
};

/**
 * In-place edits on a DRAFT record (typo fixes, attaching counter-signature
 * after the fact). Refused on ACTIVE / SUPERSEDED — those require a new
 * version via `recordTerms` (PRD §15.4: persistent until changed).
 */
export async function amendTerms(input: AmendTermsInput): Promise<TermsRecord> {
  await assertMembership(input.actorMembershipId, input.tenantId);

  const db = tenantDb(input.tenantId);
  const before = await db.termsRecord.findUnique({ where: { id: input.recordId } });
  if (!before) throw new NotFoundError("terms: record not found", "record-not-found");
  if (before.status !== "DRAFT") {
    throw new ConflictError(
      "terms: only DRAFT records can be amended in place — record a new version instead",
      "non-draft-amend",
    );
  }

  const data: Prisma.TermsRecordUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (input.body !== undefined && input.body.trim() && input.body.trim() !== before.body) {
    if (Buffer.byteLength(input.body, "utf8") > MAX_BODY) {
      throw new ValidationError("terms: body exceeds size limit", "body-too-long");
    }
    data.body = input.body.trim();
    changes.body = { from: "<previous>", to: "<new>" };
  }
  if (input.documentRef !== undefined && input.documentRef.trim() !== before.documentRef) {
    data.documentRef = input.documentRef.trim();
    changes.documentRef = { from: before.documentRef, to: input.documentRef.trim() };
  }
  if (input.notes !== undefined) {
    const next = input.notes?.trim() || null;
    if (next !== before.notes) {
      data.notes = next;
      changes.notes = { from: before.notes, to: next };
    }
  }
  if (input.signedByName !== undefined) data.signedByName = input.signedByName?.trim() || null;
  if (input.signedByRole !== undefined) data.signedByRole = input.signedByRole?.trim() || null;
  if (input.signedAt !== undefined) data.signedAt = input.signedAt;
  if (input.countersignedByName !== undefined) {
    data.countersignedByName = input.countersignedByName?.trim() || null;
  }
  if (input.countersignedAt !== undefined) data.countersignedAt = input.countersignedAt;
  if (input.effectiveFrom !== undefined) data.effectiveFrom = input.effectiveFrom;
  if (input.effectiveTo !== undefined) data.effectiveTo = input.effectiveTo;

  if (Object.keys(data).length === 0) return before;

  const updated = await db.termsRecord.update({
    where: { id: before.id },
    data,
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "TERMS_AMENDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "TermsRecord",
    subjectId: before.id,
    payload: {
      kind: before.kind,
      version: before.version,
      changes: changes as Prisma.InputJsonValue,
    },
  });

  return updated;
}

// ─── Internals ────────────────────────────────────────────────────────────

async function applyActivation(input: {
  tenantId: string;
  record: TermsRecord;
  actorMembershipId: string;
}): Promise<void> {
  const db = tenantDb(input.tenantId);
  // Move any other ACTIVE record of the same kind to SUPERSEDED.
  const previous = await db.termsRecord.findMany({
    where: {
      kind: input.record.kind,
      status: "ACTIVE",
      id: { not: input.record.id },
    },
  });
  for (const prev of previous) {
    await db.termsRecord.update({
      where: { id: prev.id },
      data: {
        status: "SUPERSEDED",
        effectiveTo: prev.effectiveTo ?? new Date(),
      },
    });
    await writeAuditEvent({
      tenantId: input.tenantId,
      eventType: "TERMS_SUPERSEDED",
      actorMembershipId: input.actorMembershipId,
      subjectType: "TermsRecord",
      subjectId: prev.id,
      payload: {
        kind: prev.kind,
        version: prev.version,
        replacedByVersion: input.record.version,
      },
    });
  }

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "TERMS_ACTIVATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "TermsRecord",
    subjectId: input.record.id,
    payload: {
      kind: input.record.kind,
      version: input.record.version,
      previousActiveVersions: previous.map((p) => p.version),
    },
  });
}

async function assertMembership(actorMembershipId: string, tenantId: string) {
  const m = await superDb.membership.findUnique({
    where: { id: actorMembershipId },
    select: { tenantId: true, status: true },
  });
  if (!m) throw new NotFoundError("terms: actor membership not found", "actor-not-found");
  if (m.tenantId !== tenantId)
    throw new ForbiddenError("terms: actor not on this tenant", "actor-wrong-tenant");
  if (m.status !== "ACTIVE")
    throw new ForbiddenError("terms: actor membership is not ACTIVE", "actor-not-active");
}

export type Status = TermsStatus;
