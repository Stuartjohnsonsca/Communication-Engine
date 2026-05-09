import type { AuditEventType } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Reviewer decision lifecycle for a Sales Identifier candidate (PRD §8.2).
 *
 * Allowed transitions from NEW or UNDER_REVIEW:
 *  - accept            → ACCEPTED          (allocate to reviewer / team)
 *  - revise            → REVISED           (reviewer corrects classification + reroutes)
 *  - reject            → REJECTED          (false positive / not pursuing)
 *  - routeToPartner    → ROUTED_TO_PARTNER (default = Acumon Intelligence; per PRD §8.3
 *                                            substituting the Client is included; any
 *                                            third party requires a fee)
 *
 * Once decided, a candidate is terminal — further changes go through a new
 * comment thread or, in Phase 4, an XCL anonymisation pipeline. Comments
 * on a decided candidate are still allowed (audit/learning).
 */

export type DecisionKind = "accept" | "revise" | "reject" | "routeToPartner";

const KIND_TO_STATUS: Record<DecisionKind, string> = {
  accept: "ACCEPTED",
  revise: "REVISED",
  reject: "REJECTED",
  routeToPartner: "ROUTED_TO_PARTNER",
};

const KIND_TO_EVENT: Record<DecisionKind, AuditEventType> = {
  accept: "OPPORTUNITY_ACCEPTED",
  revise: "OPPORTUNITY_REVISED",
  reject: "OPPORTUNITY_REJECTED",
  routeToPartner: "OPPORTUNITY_ROUTED_TO_PARTNER",
};

export type DecideInput = {
  tenantId: string;
  candidateId: string;
  actorMembershipId: string;
  kind: DecisionKind;
  /** Required for `accept`/`revise`/`routeToPartner`: who/where it goes. */
  reviewerMembershipId?: string | null;
  /** Required for `revise`: corrected classification fields. */
  revisedJurisdiction?: string | null;
  revisedServiceLine?: string | null;
  revisedClassification?: string | null;
  /** Required for `routeToPartner`: which partner type (PRD §8.3). */
  partnerType?: "DEFAULT" | "CLIENT" | "THIRD_PARTY";
  /** Free-text reason / route notes. */
  reason?: string | null;
};

export async function decideOpportunity(input: DecideInput) {
  const candidate = await superDb.opportunityCandidate.findFirst({
    where: { id: input.candidateId, tenantId: input.tenantId },
  });
  if (!candidate) throw new Error("opportunity not found");
  if (candidate.decidedAt) throw new Error("opportunity already decided");

  const newStatus = KIND_TO_STATUS[input.kind];
  const eventType = KIND_TO_EVENT[input.kind];

  const data: Parameters<typeof superDb.opportunityCandidate.update>[0]["data"] = {
    status: newStatus,
    decidedAt: new Date(),
    decidedByMembershipId: input.actorMembershipId,
    decisionReason: input.reason?.trim() || null,
  };

  if (input.kind === "accept" || input.kind === "revise") {
    if (!input.reviewerMembershipId) {
      throw new Error(`${input.kind}: reviewerMembershipId required (allocation target)`);
    }
    data.reviewerMembershipId = input.reviewerMembershipId;
  }

  if (input.kind === "revise") {
    if (input.revisedJurisdiction !== undefined) data.jurisdiction = input.revisedJurisdiction;
    if (input.revisedServiceLine !== undefined) data.serviceLine = input.revisedServiceLine;
    if (input.revisedClassification !== undefined) data.classification = input.revisedClassification;
  }

  if (input.kind === "routeToPartner") {
    data.partnerType = input.partnerType ?? "DEFAULT";
    data.routeNotes = input.reason?.trim() || null;
  }

  const updated = await superDb.opportunityCandidate.update({
    where: { id: candidate.id },
    data,
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType,
    actorMembershipId: input.actorMembershipId,
    subjectType: "OpportunityCandidate",
    subjectId: updated.id,
    payload: {
      kind: input.kind,
      previousStatus: candidate.status,
      newStatus,
      reviewerMembershipId: updated.reviewerMembershipId,
      partnerType: updated.partnerType,
      jurisdiction: updated.jurisdiction,
      serviceLine: updated.serviceLine,
      classification: updated.classification,
      reason: updated.decisionReason ?? updated.routeNotes ?? null,
    },
  });

  return updated;
}

export async function addOpportunityComment(input: {
  tenantId: string;
  candidateId: string;
  actorMembershipId: string;
  body: string;
}) {
  const text = input.body.trim();
  if (!text) throw new Error("comment body required");
  if (text.length > 4000) throw new Error("comment too long (max 4000 chars)");

  const candidate = await superDb.opportunityCandidate.findFirst({
    where: { id: input.candidateId, tenantId: input.tenantId },
    select: { id: true },
  });
  if (!candidate) throw new Error("opportunity not found");

  const comment = await superDb.opportunityComment.create({
    data: {
      tenantId: input.tenantId,
      candidateId: input.candidateId,
      authorMembershipId: input.actorMembershipId,
      body: text,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "OPPORTUNITY_COMMENTED",
    actorMembershipId: input.actorMembershipId,
    subjectType: "OpportunityCandidate",
    subjectId: input.candidateId,
    payload: {
      commentId: comment.id,
      bodyLength: text.length,
    },
  });

  return comment;
}
