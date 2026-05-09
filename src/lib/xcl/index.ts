import type {
  Prisma,
  Tenant,
  XclCandidate,
  XclCandidateStatus,
  XclInsightKind,
  XclReidentificationTest,
} from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { redact, residualIdentifierCheck, type RedactionEntry } from "@/lib/xcl/redact";

/**
 * Cross-Client Learning (PRD §11) — module surface.
 *
 * Two halves:
 *   1. Per-tenant opt-in / opt-out (PRD §11.2). The tenant's FIRM_ADMIN
 *      flips the lawful-basis gate; a separate addendum reference + signer
 *      name is captured. Without opt-in, no candidates from this tenant
 *      ever enter the queue.
 *   2. Global curator pipeline (PRD §11.3). Candidates are auto-redacted
 *      on creation, queued, reviewed by an Acumon Curator, and either
 *      committed into global defaults (PRD §11.4) or rejected. Rejection
 *      rate + rationale are tracked. Quarterly re-identification testing
 *      is logged via `recordReidentificationTest`.
 *
 * Authorisation is enforced by the API routes (xcl:opt-in / xcl:curate);
 * these helpers assume a permitted actor. Audit events for opt-in/out are
 * written against the source tenant's chain; audit events for curator
 * actions are written against the operator's tenant chain (Acumon).
 */

const ACUMON_TENANT_SLUG = "acumon";

// ─── Per-tenant opt-in ────────────────────────────────────────────────────

export type SetOptInInput = {
  tenantId: string;
  optIn: boolean;
  /** Required when opting in: who signed the addendum. */
  signedByName?: string | null;
  /** Reference to the addendum document in the Client's records. */
  addendumRef?: string | null;
  /** Required when opting out: free-form reason. */
  reason?: string | null;
  actorMembershipId: string;
};

export async function setOptIn(input: SetOptInInput): Promise<Tenant> {
  const tenant = await superDb.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new Error("xcl: tenant not found");

  const wasOptedIn = tenant.pricingCrossClientLearningOptIn;
  if (wasOptedIn === input.optIn) return tenant; // idempotent

  if (input.optIn) {
    if (!input.signedByName || !input.signedByName.trim()) {
      throw new Error("xcl: opt-in requires the addendum signer's name");
    }
    if (!input.addendumRef || !input.addendumRef.trim()) {
      throw new Error("xcl: opt-in requires an addendum reference (document id / version)");
    }
  }

  const data: Prisma.TenantUpdateInput = input.optIn
    ? {
        pricingCrossClientLearningOptIn: true,
        crossClientLearningOptedInAt: new Date(),
        crossClientLearningOptedInByName: input.signedByName!.trim(),
        crossClientLearningAddendumRef: input.addendumRef!.trim(),
        crossClientLearningOptedOutAt: null,
        crossClientLearningOptedOutReason: null,
      }
    : {
        pricingCrossClientLearningOptIn: false,
        crossClientLearningOptedOutAt: new Date(),
        crossClientLearningOptedOutReason: input.reason?.trim() || null,
      };

  const updated = await superDb.tenant.update({
    where: { id: tenant.id },
    data,
  });

  await writeAuditEvent({
    tenantId: tenant.id,
    eventType: input.optIn ? "XCL_OPT_IN" : "XCL_OPT_OUT",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Tenant",
    subjectId: tenant.id,
    payload: input.optIn
      ? {
          signedByName: input.signedByName!.trim(),
          addendumRef: input.addendumRef!.trim(),
        }
      : { reason: input.reason?.trim() ?? null },
  });

  return updated;
}

// ─── Curator pipeline ─────────────────────────────────────────────────────

export type ProposeCandidateInput = {
  sourceTenantId: string;
  sourceSubjectType: string;
  sourceSubjectId: string;
  kind: XclInsightKind;
  originalText: string;
  /// Caller membership recording the proposal — usually the tenant operator
  /// who flagged the insight, not the curator. Audited against the source tenant.
  actorMembershipId: string;
};

const MAX_INSIGHT_LEN = 8_000;

export async function proposeCandidate(input: ProposeCandidateInput): Promise<XclCandidate> {
  const tenant = await superDb.tenant.findUnique({ where: { id: input.sourceTenantId } });
  if (!tenant) throw new Error("xcl: source tenant not found");
  if (!tenant.pricingCrossClientLearningOptIn) {
    throw new Error("xcl: source tenant has not opted in (PRD §11.2)");
  }

  const trimmed = input.originalText.trim();
  if (!trimmed) throw new Error("xcl: insight text is required");
  if (trimmed.length > MAX_INSIGHT_LEN) {
    throw new Error("xcl: insight exceeds maximum length");
  }

  const { redactedText, log } = redact(trimmed);

  const candidate = await superDb.xclCandidate.create({
    data: {
      sourceTenantId: input.sourceTenantId,
      sourceSubjectType: input.sourceSubjectType,
      sourceSubjectId: input.sourceSubjectId,
      kind: input.kind,
      status: "PENDING",
      originalText: trimmed,
      redactedText,
      redactionLog: log as unknown as Prisma.InputJsonValue,
    },
  });

  await writeAuditEvent({
    tenantId: input.sourceTenantId,
    eventType: "XCL_CANDIDATE_PROPOSED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "XclCandidate",
    subjectId: candidate.id,
    payload: {
      kind: input.kind,
      sourceSubjectType: input.sourceSubjectType,
      sourceSubjectId: input.sourceSubjectId,
      redactionCount: log.length,
      residualSuspected: residualIdentifierCheck(redactedText),
    },
  });

  return candidate;
}

export type ReviewCandidateInput = {
  candidateId: string;
  decision: "APPROVE" | "REJECT" | "COMMIT";
  notes?: string | null;
  /// Acumon-tenant membership of the curator. Audit chain attribution.
  curatorTenantId: string;
  curatorMembershipId: string;
  curatorName: string;
};

export async function reviewCandidate(input: ReviewCandidateInput): Promise<XclCandidate> {
  const before = await superDb.xclCandidate.findUnique({ where: { id: input.candidateId } });
  if (!before) throw new Error("xcl: candidate not found");

  // Validate state machine
  if (input.decision === "APPROVE" && before.status !== "PENDING") {
    throw new Error(`xcl: cannot approve from status ${before.status}`);
  }
  if (input.decision === "REJECT" && before.status === "COMMITTED") {
    throw new Error("xcl: cannot reject a committed candidate");
  }
  if (input.decision === "COMMIT" && before.status !== "APPROVED") {
    throw new Error("xcl: must approve before committing");
  }

  const data: Prisma.XclCandidateUpdateInput = {
    curatorMembershipId: input.curatorMembershipId,
    curatorTenantId: input.curatorTenantId,
    curatorDecidedAt: new Date(),
    curatorNotes: input.notes?.trim() || null,
  };

  let eventType:
    | "XCL_CANDIDATE_APPROVED"
    | "XCL_CANDIDATE_REJECTED"
    | "XCL_CANDIDATE_COMMITTED";
  if (input.decision === "APPROVE") {
    data.status = "APPROVED";
    eventType = "XCL_CANDIDATE_APPROVED";
  } else if (input.decision === "REJECT") {
    data.status = "REJECTED";
    eventType = "XCL_CANDIDATE_REJECTED";
  } else {
    data.status = "COMMITTED";
    data.committedAt = new Date();
    data.committedByName = input.curatorName;
    eventType = "XCL_CANDIDATE_COMMITTED";
  }

  const after = await superDb.xclCandidate.update({
    where: { id: before.id },
    data,
  });

  await writeAuditEvent({
    tenantId: input.curatorTenantId,
    eventType,
    actorMembershipId: input.curatorMembershipId,
    subjectType: "XclCandidate",
    subjectId: before.id,
    payload: {
      kind: before.kind,
      sourceTenantId: before.sourceTenantId,
      previousStatus: before.status,
      hadNotes: !!input.notes?.trim(),
    },
  });

  return after;
}

// ─── Re-identification testing ────────────────────────────────────────────

export type RecordReidentificationTestInput = {
  quarter: string;
  conductedAt: Date;
  conductedByName: string;
  externalReviewer?: boolean;
  sampleSize: number;
  reidentifiedCount: number;
  summary: string;
  notes?: string | null;
  /** Acumon-tenant operator recording the test. Audit chain attribution. */
  actorTenantId: string;
  actorMembershipId: string;
};

export async function recordReidentificationTest(
  input: RecordReidentificationTestInput,
): Promise<XclReidentificationTest> {
  if (!/^\d{4}-Q[1-4]$/.test(input.quarter)) {
    throw new Error("xcl: quarter must be YYYY-Qn (e.g. 2026-Q2)");
  }
  if (input.sampleSize < 1) throw new Error("xcl: sampleSize must be >= 1");
  if (input.reidentifiedCount < 0 || input.reidentifiedCount > input.sampleSize) {
    throw new Error("xcl: reidentifiedCount must be between 0 and sampleSize");
  }
  if (!input.summary.trim()) throw new Error("xcl: summary is required");

  // Upsert by quarter — a re-test of the same quarter overwrites (audited).
  const before = await superDb.xclReidentificationTest.findUnique({
    where: { quarter: input.quarter },
  });

  const after = await superDb.xclReidentificationTest.upsert({
    where: { quarter: input.quarter },
    create: {
      quarter: input.quarter,
      conductedAt: input.conductedAt,
      conductedByName: input.conductedByName.trim(),
      externalReviewer: input.externalReviewer ?? true,
      sampleSize: input.sampleSize,
      reidentifiedCount: input.reidentifiedCount,
      summary: input.summary.trim(),
      notes: input.notes?.trim() || null,
    },
    update: {
      conductedAt: input.conductedAt,
      conductedByName: input.conductedByName.trim(),
      externalReviewer: input.externalReviewer ?? true,
      sampleSize: input.sampleSize,
      reidentifiedCount: input.reidentifiedCount,
      summary: input.summary.trim(),
      notes: input.notes?.trim() || null,
    },
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "XCL_REID_TEST_RECORDED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "XclReidentificationTest",
    subjectId: after.id,
    payload: {
      quarter: input.quarter,
      sampleSize: input.sampleSize,
      reidentifiedCount: input.reidentifiedCount,
      externalReviewer: input.externalReviewer ?? true,
      replaced: before != null,
    },
  });

  return after;
}

// ─── Views ────────────────────────────────────────────────────────────────

export type CuratorView = {
  pending: XclCandidate[];
  approved: XclCandidate[];
  recent: XclCandidate[];
  reidTests: XclReidentificationTest[];
  rejectionRate: { decided: number; rejected: number };
};

export async function getCuratorView(): Promise<CuratorView> {
  const [pending, approved, recent, reidTests, decidedAgg] = await Promise.all([
    superDb.xclCandidate.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
    superDb.xclCandidate.findMany({
      where: { status: "APPROVED" },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
    superDb.xclCandidate.findMany({
      orderBy: { updatedAt: "desc" },
      take: 30,
    }),
    superDb.xclReidentificationTest.findMany({
      orderBy: { conductedAt: "desc" },
      take: 12,
    }),
    superDb.xclCandidate.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  let decided = 0;
  let rejected = 0;
  for (const row of decidedAgg) {
    if (row.status !== "PENDING") decided += row._count._all;
    if (row.status === "REJECTED") rejected = row._count._all;
  }

  return { pending, approved, recent, reidTests, rejectionRate: { decided, rejected } };
}

export type ClientXclView = {
  optedIn: boolean;
  optedInAt: Date | null;
  optedInByName: string | null;
  addendumRef: string | null;
  optedOutAt: Date | null;
  /** Counts of this tenant's candidates by status (provenance only). */
  counts: Record<XclCandidateStatus, number>;
};

export async function getClientView(tenantId: string): Promise<ClientXclView> {
  const tenant = await superDb.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error("xcl: tenant not found");

  const grouped = await superDb.xclCandidate.groupBy({
    by: ["status"],
    where: { sourceTenantId: tenantId },
    _count: { _all: true },
  });
  const counts: Record<XclCandidateStatus, number> = {
    PENDING: 0,
    APPROVED: 0,
    REJECTED: 0,
    COMMITTED: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;

  return {
    optedIn: tenant.pricingCrossClientLearningOptIn,
    optedInAt: tenant.crossClientLearningOptedInAt,
    optedInByName: tenant.crossClientLearningOptedInByName,
    addendumRef: tenant.crossClientLearningAddendumRef,
    optedOutAt: tenant.crossClientLearningOptedOutAt,
    counts,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function isAcumonOperator(tenantSlug: string): boolean {
  return tenantSlug === ACUMON_TENANT_SLUG;
}

export type { RedactionEntry };
