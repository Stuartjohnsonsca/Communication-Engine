import type { Prisma, SignOffQuestion, SignOffStatus } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Open Questions for Sign-Off (PRD §18). Internal Acumon governance — the
 * eleven product / legal / commercial decisions enumerated in the PRD body
 * that need explicit answers before GA. NOT a §15.3 transparency surface;
 * this module is read-only to Client tenants by being entirely invisible to
 * them. Both reads and writes are gated on `tenant.slug === "acumon"` in the
 * page handler.
 *
 * SignOffQuestion rows live outside RLS (see `prisma/rls.sql`). Audit events
 * for decisions/updates are written against the *operator's* tenant chain so
 * they're verifiable inside the standard audit-log UI.
 *
 * Defence-in-depth: every mutation function below re-reads the actor's
 * Membership and refuses if the membership is not in the "acumon" tenant.
 * A misconfigured caller cannot bypass the gate by passing a forged
 * `actorTenantId`.
 */

const ACUMON_SLUG = "acumon";

export const STATUS_OPTIONS: SignOffStatus[] = ["OPEN", "DECIDED", "DEFERRED"];

export type SignOffView = {
  questions: SignOffQuestion[];
  summary: {
    total: number;
    byStatus: Record<SignOffStatus, number>;
  };
};

export async function getSignOffQuestions(): Promise<SignOffView> {
  const questions = await superDb.signOffQuestion.findMany({
    orderBy: { ordinal: "asc" },
  });
  const byStatus: Record<SignOffStatus, number> = {
    OPEN: 0,
    DECIDED: 0,
    DEFERRED: 0,
  };
  for (const q of questions) byStatus[q.status]++;
  return {
    questions,
    summary: { total: questions.length, byStatus },
  };
}

// ─── Mutations ─────────────────────────────────────────────────────────────

/**
 * Re-validate that the operator is on the Acumon tenant by reading the
 * membership server-side, not by trusting whatever the caller passed in.
 * Throws if not — callers should not catch; let the request 500 (and audit
 * via the surrounding error boundary) so the caller is forced to fix the gate.
 */
async function assertAcumonOperator(actorMembershipId: string) {
  const membership = await superDb.membership.findUnique({
    where: { id: actorMembershipId },
    include: { tenant: { select: { slug: true } } },
  });
  if (!membership) throw new Error("signoff: actor membership not found");
  if (membership.tenant.slug !== ACUMON_SLUG) {
    throw new Error("signoff: actor is not on the Acumon tenant");
  }
  if (membership.status !== "ACTIVE") {
    throw new Error("signoff: actor membership is not ACTIVE");
  }
  return membership;
}

const MAX_DECISION_LEN = 4_000;
const MAX_NOTES_LEN = 4_000;
const MAX_DECIDED_BY_LEN = 200;

function clampText(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export type DecideQuestionInput = {
  code: string;
  decision: string;
  decidedByName?: string | null;
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
  actorName: string;
};

export async function decideQuestion(input: DecideQuestionInput): Promise<SignOffQuestion> {
  await assertAcumonOperator(input.actorMembershipId);

  const decision = clampText(input.decision, MAX_DECISION_LEN);
  if (!decision) throw new Error("signoff: decision text is required");

  const before = await superDb.signOffQuestion.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`signoff: question ${input.code} not found`);

  const decidedByName =
    clampText(input.decidedByName, MAX_DECIDED_BY_LEN) ??
    clampText(input.actorName, MAX_DECIDED_BY_LEN);
  const notes = clampText(input.notes, MAX_NOTES_LEN);

  const after = await superDb.signOffQuestion.update({
    where: { id: before.id },
    data: {
      status: "DECIDED",
      decision,
      decidedAt: new Date(),
      decidedByName,
      notes,
    },
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "SIGNOFF_QUESTION_DECIDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "SignOffQuestion",
    subjectId: before.id,
    payload: {
      code: before.code,
      previousStatus: before.status,
      decidedByName,
      decisionLength: decision.length,
    },
  });

  return after;
}

export type ReopenQuestionInput = {
  code: string;
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
};

export async function reopenQuestion(input: ReopenQuestionInput): Promise<SignOffQuestion> {
  await assertAcumonOperator(input.actorMembershipId);

  const before = await superDb.signOffQuestion.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`signoff: question ${input.code} not found`);

  if (before.status === "OPEN") return before;

  const notes = clampText(input.notes, MAX_NOTES_LEN);

  const after = await superDb.signOffQuestion.update({
    where: { id: before.id },
    data: {
      status: "OPEN",
      decision: null,
      decidedAt: null,
      decidedByName: null,
      notes: notes ?? before.notes,
    },
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "SIGNOFF_QUESTION_REOPENED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "SignOffQuestion",
    subjectId: before.id,
    payload: {
      code: before.code,
      previousStatus: before.status,
      previousDecidedByName: before.decidedByName,
    },
  });

  return after;
}

export type UpdateQuestionInput = {
  code: string;
  status?: SignOffStatus;
  notes?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
};

/**
 * Edit a question's tracking metadata WITHOUT recording a decision. Used for
 * the "Defer" action and free-form notes edits. Status transitions to/from
 * DECIDED must go through `decideQuestion` / `reopenQuestion`, which handle
 * the `decision` / `decidedAt` columns and emit the corresponding event.
 */
export async function updateQuestion(input: UpdateQuestionInput): Promise<SignOffQuestion> {
  await assertAcumonOperator(input.actorMembershipId);

  const before = await superDb.signOffQuestion.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`signoff: question ${input.code} not found`);

  const data: Prisma.SignOffQuestionUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (input.status !== undefined && input.status !== before.status) {
    if (input.status === "DECIDED") {
      throw new Error("signoff: use decideQuestion to record a decision");
    }
    if (before.status === "DECIDED") {
      // Transitioning OUT of DECIDED erases the captured decision so the
      // page never shows stale text against a non-decided status. (We've
      // already rejected status === "DECIDED" above, so any change from
      // DECIDED here is a downgrade.)
      data.decision = null;
      data.decidedAt = null;
      data.decidedByName = null;
    }
    data.status = input.status;
    changes.status = { from: before.status, to: input.status };
  }

  if (input.notes !== undefined) {
    const next = clampText(input.notes, MAX_NOTES_LEN);
    if (next !== before.notes) {
      data.notes = next;
      changes.notes = { from: before.notes, to: next };
    }
  }

  if (Object.keys(changes).length === 0) return before;

  const after = await superDb.signOffQuestion.update({
    where: { id: before.id },
    data,
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "SIGNOFF_QUESTION_UPDATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "SignOffQuestion",
    subjectId: before.id,
    payload: {
      code: before.code,
      changes: changes as Prisma.InputJsonValue,
    },
  });

  return after;
}
