import { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { classifyOpportunity } from "@/lib/ai/agents/opportunityAgent";
import { getDpiaStatus } from "@/lib/dpia/status";

/**
 * Sales Identifier detection orchestration (PRD §8).
 *
 * Called when a new inbound message arrives (and on the manual "scan"
 * action in the reviewer console). Three gates apply before any inference
 * actually runs:
 *
 *  1. `tenant.salesIdentifierEnabled` — admin must have switched the
 *     add-on on. Without this, the inbound is ignored entirely.
 *  2. `tenant.salesIdentifierLawfulBasisAttestedAt` — PRD §8.5 requires a
 *     separate lawful-basis acknowledgement before counterparty
 *     correspondence is mined for revenue purposes. Refuse if absent.
 *  3. DPIA gate — `getDpiaStatus().salesIdentifierAllowed`. The Sales
 *     Identifier feature pauses on DPIA expiry / scope drift / never-
 *     attested per PRD §12.2. The detector treats this as a soft gate
 *     and returns `{ skipped: "dpia_paused" }` so the caller can decide
 *     whether to surface the gate state.
 *
 * On a positive call (confidence >= floor) we persist an
 * OpportunityCandidate and emit OPPORTUNITY_DETECTED. On a negative call
 * we discard the result — no row, no audit noise. The model run is still
 * recorded centrally via the LLM client.
 */

export const OPPORTUNITY_CONFIDENCE_FLOOR = 0.5;

export type DetectInput = {
  tenantId: string;
  ingestedMessageId: string;
  inbound: {
    channel: string;
    sender?: string | null;
    subject?: string | null;
    body: string;
  };
};

export type DetectResult =
  | { skipped: "disabled" | "no_lawful_basis" | "dpia_paused" | "below_floor"; confidence?: number; reason?: string }
  | { detected: { id: string; classification: string; confidence: number } };

export async function detectOpportunity(input: DetectInput): Promise<DetectResult> {
  const tenant = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: {
      id: true,
      jurisdiction: true,
      salesIdentifierEnabled: true,
      salesIdentifierLawfulBasisAttestedAt: true,
    },
  });
  if (!tenant) throw new Error(`detectOpportunity: tenant ${input.tenantId} not found`);

  if (!tenant.salesIdentifierEnabled) return { skipped: "disabled" };
  if (!tenant.salesIdentifierLawfulBasisAttestedAt) return { skipped: "no_lawful_basis" };

  const dpia = await getDpiaStatus(input.tenantId);
  if (!dpia.salesIdentifierAllowed) return { skipped: "dpia_paused" };

  const { result, modelRunId } = await classifyOpportunity({
    ...input.inbound,
    context: { jurisdiction: tenant.jurisdiction },
  });

  if (result.confidence < OPPORTUNITY_CONFIDENCE_FLOOR) {
    return { skipped: "below_floor", confidence: result.confidence, reason: result.rationale };
  }

  const signalQuotes: Prisma.InputJsonValue = result.signalQuotes;
  const candidate = await superDb.opportunityCandidate.create({
    data: {
      tenantId: input.tenantId,
      sourceIngestedMessageId: input.ingestedMessageId,
      jurisdiction: result.jurisdiction,
      serviceLine: result.serviceLine,
      classification: result.classification,
      confidence: result.confidence,
      rationale: result.rationale,
      signalQuotes,
      suggestedReviewerTeam: result.suggestedReviewerTeam,
      status: "NEW",
      partnerType: "DEFAULT",
      modelRunId: modelRunId ?? null,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "OPPORTUNITY_DETECTED",
    actorMembershipId: null,
    subjectType: "OpportunityCandidate",
    subjectId: candidate.id,
    payload: {
      ingestedMessageId: input.ingestedMessageId,
      jurisdiction: result.jurisdiction,
      serviceLine: result.serviceLine,
      classification: result.classification,
      confidence: result.confidence,
      suggestedReviewerTeam: result.suggestedReviewerTeam,
    },
  });

  return {
    detected: {
      id: candidate.id,
      classification: candidate.classification ?? result.classification,
      confidence: candidate.confidence ?? result.confidence,
    },
  };
}
