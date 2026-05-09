import type { Prisma, SignOffQuestion, SignOffStatus } from "@prisma/client";
import { tenantDb, superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Open Questions for Sign-Off (PRD §18). Each tenant has its own copy of
 * the ten enumerated questions and answers them for themselves (their
 * controller/processor model, their UCG retention period, their quorum
 * default, their WhatsApp posture, their pricing position). Two tenants on
 * the same product instance must NOT see each other's answers.
 *
 * Security model:
 *  1. RLS on `SignOffQuestion` (see `prisma/rls.sql`) blocks cross-tenant
 *     reads/writes at the database level — defence in depth on top of the
 *     WHERE clauses below.
 *  2. Every public function requires a `tenantId`; queries go through
 *     `tenantDb(tenantId)` so the per-transaction `app.current_tenant`
 *     GUC is set before any row is read or written.
 *  3. The page handler enforces RBAC (`signoff:read` / `signoff:manage`)
 *     within the tenant — the FIRM_ADMIN of THIS tenant manages THEIR
 *     questions; nobody manages anyone else's.
 *  4. Audit events are written into the same tenant's audit chain.
 *
 * Acumon (the vendor) is itself a Client tenant and uses this module
 * exactly the same way every other Client does. There is no privileged
 * cross-tenant view.
 */

export const STATUS_OPTIONS: SignOffStatus[] = ["OPEN", "DECIDED", "DEFERRED"];

const MAX_DECISION_LEN = 4_000;
const MAX_NOTES_LEN = 4_000;
const MAX_DECIDED_BY_LEN = 200;

type CanonicalQuestion = {
  code: string;
  ordinal: number;
  question: string;
  prdAssumption: string | null;
};

/**
 * Canonical PRD §18 questions, used for lazy-seeding a tenant on first
 * read. Mirrors the static columns the migration would otherwise INSERT —
 * we do it from the application instead so we don't need to backfill all
 * existing tenants in the migration, and so revising the question list
 * later is a code change rather than a schema migration.
 */
export const PRD_SIGNOFF_QUESTIONS: ReadonlyArray<CanonicalQuestion> = [
  {
    code: "Q-01",
    ordinal: 0,
    question: "Confirm controller / processor model for the core service.",
    prdAssumption: "PRD assumption A1.",
  },
  {
    code: "Q-02",
    ordinal: 1,
    question: "Confirm the User Culture Guide retention period post-departure.",
    prdAssumption: "Default 30 days, anonymise or delete.",
  },
  {
    code: "Q-03",
    ordinal: 2,
    question: "Confirm quorum default and the Emergency amendment window.",
    prdAssumption: "Simple majority of total membership; 24-hour Emergency window.",
  },
  {
    code: "Q-04",
    ordinal: 3,
    question: "Confirm Sales Identifier Partner pricing structure.",
    prdAssumption: "Default discount; Client-as-Partner free; third-party fee.",
  },
  {
    code: "Q-05",
    ordinal: 4,
    question: "Confirm jurisdictional split for EU residency.",
    prdAssumption:
      "Single EU region (Ireland) or Client-selected (Ireland / Frankfurt / Paris).",
  },
  {
    code: "Q-06",
    ordinal: 5,
    question:
      "Confirm whether voice transcription has an in-region sub-processor available for all v1 jurisdictions, or whether voice is held back to P2.",
    prdAssumption: null,
  },
  {
    code: "Q-07",
    ordinal: 6,
    question: "Confirm position on personal WhatsApp.",
    prdAssumption: "Excluded by design (recommended) versus opt-in by User.",
  },
  {
    code: "Q-08",
    ordinal: 7,
    question: "Confirm certifications budget and timeline.",
    prdAssumption: "ISO 27001 + Cyber Essentials Plus by GA — aggressive.",
  },
  {
    code: "Q-09",
    ordinal: 8,
    question: "Confirm pilot scope and timing for Acumon Intelligence as Pilot Client.",
    prdAssumption: null,
  },
  {
    code: "Q-10",
    ordinal: 9,
    question: "Confirm pricing tiers and the discount values.",
    prdAssumption: "Acumon-as-default-Partner; Cross-Client Learning opt-in.",
  },
];

export type SignOffView = {
  questions: SignOffQuestion[];
  summary: {
    total: number;
    byStatus: Record<SignOffStatus, number>;
  };
};

/**
 * Idempotent lazy seed. Inserts any missing canonical questions for the
 * tenant; existing rows (with their captured decisions) are preserved.
 *
 * Run inside the tenant-scoped client so RLS still enforces isolation
 * even though the unique constraint already does. We deliberately use
 * `createMany` with `skipDuplicates` so a concurrent first read from two
 * sessions can't double-insert.
 */
async function ensureSeeded(tenantId: string) {
  const db = tenantDb(tenantId);
  const existingCount = await db.signOffQuestion.count();
  if (existingCount >= PRD_SIGNOFF_QUESTIONS.length) return;

  await db.signOffQuestion.createMany({
    data: PRD_SIGNOFF_QUESTIONS.map((q) => ({
      tenantId,
      code: q.code,
      ordinal: q.ordinal,
      question: q.question,
      prdAssumption: q.prdAssumption,
    })),
    skipDuplicates: true,
  });
}

export async function getSignOffQuestions(tenantId: string): Promise<SignOffView> {
  await ensureSeeded(tenantId);
  const db = tenantDb(tenantId);
  const questions = await db.signOffQuestion.findMany({ orderBy: { ordinal: "asc" } });
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

function clampText(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Defence in depth: re-read the actor's membership server-side and
 * confirm it belongs to the tenant the caller claims to be acting in.
 * Refuses the action otherwise. Catches the case where a forged
 * `actorMembershipId` is paired with a different `tenantId`.
 */
async function assertMembershipOnTenant(actorMembershipId: string, tenantId: string) {
  const membership = await superDb.membership.findUnique({
    where: { id: actorMembershipId },
    select: { id: true, tenantId: true, status: true },
  });
  if (!membership) throw new Error("signoff: actor membership not found");
  if (membership.tenantId !== tenantId) {
    throw new Error("signoff: actor membership is not on this tenant");
  }
  if (membership.status !== "ACTIVE") {
    throw new Error("signoff: actor membership is not ACTIVE");
  }
}

export type DecideQuestionInput = {
  tenantId: string;
  code: string;
  decision: string;
  decidedByName?: string | null;
  notes?: string | null;
  actorMembershipId: string;
  actorName: string;
};

export async function decideQuestion(input: DecideQuestionInput): Promise<SignOffQuestion> {
  await assertMembershipOnTenant(input.actorMembershipId, input.tenantId);
  await ensureSeeded(input.tenantId);

  const decision = clampText(input.decision, MAX_DECISION_LEN);
  if (!decision) throw new Error("signoff: decision text is required");

  const db = tenantDb(input.tenantId);
  const before = await db.signOffQuestion.findUnique({
    where: { tenantId_code: { tenantId: input.tenantId, code: input.code } },
  });
  if (!before) throw new Error(`signoff: question ${input.code} not found for tenant`);

  const decidedByName =
    clampText(input.decidedByName, MAX_DECIDED_BY_LEN) ??
    clampText(input.actorName, MAX_DECIDED_BY_LEN);
  const notes = clampText(input.notes, MAX_NOTES_LEN);

  const after = await db.signOffQuestion.update({
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
    tenantId: input.tenantId,
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
  tenantId: string;
  code: string;
  notes?: string | null;
  actorMembershipId: string;
};

export async function reopenQuestion(input: ReopenQuestionInput): Promise<SignOffQuestion> {
  await assertMembershipOnTenant(input.actorMembershipId, input.tenantId);

  const db = tenantDb(input.tenantId);
  const before = await db.signOffQuestion.findUnique({
    where: { tenantId_code: { tenantId: input.tenantId, code: input.code } },
  });
  if (!before) throw new Error(`signoff: question ${input.code} not found for tenant`);

  if (before.status === "OPEN") return before;

  const notes = clampText(input.notes, MAX_NOTES_LEN);

  const after = await db.signOffQuestion.update({
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
    tenantId: input.tenantId,
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
  tenantId: string;
  code: string;
  status?: SignOffStatus;
  notes?: string | null;
  actorMembershipId: string;
};

/**
 * Edit a question's tracking metadata WITHOUT recording a decision. Used
 * for the "Defer" action and free-form notes edits. Status transitions
 * to/from DECIDED must go through `decideQuestion` / `reopenQuestion`.
 */
export async function updateQuestion(input: UpdateQuestionInput): Promise<SignOffQuestion> {
  await assertMembershipOnTenant(input.actorMembershipId, input.tenantId);

  const db = tenantDb(input.tenantId);
  const before = await db.signOffQuestion.findUnique({
    where: { tenantId_code: { tenantId: input.tenantId, code: input.code } },
  });
  if (!before) throw new Error(`signoff: question ${input.code} not found for tenant`);

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

  const after = await db.signOffQuestion.update({
    where: { id: before.id },
    data,
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
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
