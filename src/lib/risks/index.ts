import type { Prisma, Risk, RiskSeverity, RiskStatus } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Risks Register module (PRD §17). Global product-level risks — same eleven
 * rows for every tenant. Mutations are restricted to Acumon operators
 * (FIRM_ADMIN of the "acumon" tenant or ACUMON_ADMIN); the audit event is
 * written against the operator's own tenant chain.
 *
 * Risk rows live outside RLS — see `prisma/rls.sql`. Tenant scoping does not
 * apply because the data is product-level, not per-Client.
 */

export const SEVERITY_ORDER: RiskSeverity[] = ["HIGH", "MEDIUM", "LOW"];

export type RisksView = {
  risks: Risk[];
  /** Quick top-of-page counts the page card uses. */
  summary: {
    total: number;
    bySeverity: Record<RiskSeverity, number>;
    byStatus: Record<RiskStatus, number>;
    /** Risks that have never been ticked as reviewed. */
    neverReviewed: number;
  };
};

export async function getRisks(): Promise<RisksView> {
  const risks = await superDb.risk.findMany({ orderBy: { ordinal: "asc" } });
  const bySeverity: Record<RiskSeverity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  const byStatus: Record<RiskStatus, number> = { ACTIVE: 0, MITIGATED: 0, ACCEPTED: 0, CLOSED: 0 };
  let neverReviewed = 0;
  for (const r of risks) {
    bySeverity[r.severity]++;
    byStatus[r.status]++;
    if (!r.reviewedAt) neverReviewed++;
  }
  return {
    risks,
    summary: { total: risks.length, bySeverity, byStatus, neverReviewed },
  };
}

// ─── Mutations ─────────────────────────────────────────────────────────────

export type UpdateRiskInput = {
  code: string;
  status?: RiskStatus;
  severity?: RiskSeverity;
  notes?: string | null;
  /** Operator's tenant — for audit chain attribution. */
  actorTenantId: string;
  actorMembershipId: string;
};

export async function updateRisk(input: UpdateRiskInput): Promise<Risk> {
  const before = await superDb.risk.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`risk: ${input.code} not found`);

  const data: Prisma.RiskUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (input.status !== undefined && input.status !== before.status) {
    data.status = input.status;
    changes.status = { from: before.status, to: input.status };
  }
  if (input.severity !== undefined && input.severity !== before.severity) {
    data.severity = input.severity;
    changes.severity = { from: before.severity, to: input.severity };
  }
  if (input.notes !== undefined) {
    const trimmed = input.notes?.trim() || null;
    if (trimmed !== before.notes) {
      data.notes = trimmed;
      changes.notes = { from: before.notes, to: trimmed };
    }
  }

  if (Object.keys(changes).length === 0) return before;

  const after = await superDb.risk.update({ where: { id: before.id }, data });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "RISK_UPDATED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Risk",
    subjectId: before.id,
    payload: {
      code: before.code,
      changes: changes as Prisma.InputJsonValue,
    },
  });

  return after;
}

export type ReviewRiskInput = {
  code: string;
  /** Captured for the public card. Falls back to actor name if blank. */
  reviewedByName?: string | null;
  actorTenantId: string;
  actorMembershipId: string;
  actorName: string;
};

export async function reviewRisk(input: ReviewRiskInput): Promise<Risk> {
  const before = await superDb.risk.findUnique({ where: { code: input.code } });
  if (!before) throw new Error(`risk: ${input.code} not found`);

  const reviewedAt = new Date();
  const reviewedByName =
    input.reviewedByName?.trim() || input.actorName.trim() || null;

  const after = await superDb.risk.update({
    where: { id: before.id },
    data: { reviewedAt, reviewedByName },
  });

  await writeAuditEvent({
    tenantId: input.actorTenantId,
    eventType: "RISK_REVIEWED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "Risk",
    subjectId: before.id,
    payload: {
      code: before.code,
      reviewedByName,
      previousReviewAt: before.reviewedAt?.toISOString() ?? null,
    },
  });

  return after;
}
