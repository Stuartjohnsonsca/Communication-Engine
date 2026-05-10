import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { dispatchAdherenceEscalation } from "@/lib/notifications/immediate";
import { reportError } from "@/lib/observability";

/**
 * Backlog item 1 — adherence escalation threshold.
 *
 * Overall adherence is 0..1 (the judge's normalised score across the five
 * §9.1 dimensions). Below this threshold the row is escalated into the
 * User+FCT inbox in the same lane as a sentiment escalation. Set to 0.6 to
 * mirror the sentiment confidence floor — values below it consistently
 * indicate at least one dimension scored "fail" or "partial" with weak
 * compensating dimensions.
 *
 * Choosing too tight a threshold floods the FCT; too loose and a poor
 * communication slips through. 0.6 is a reasonable starting line and is
 * recorded explicitly so it can be tuned in one place.
 */
export const ADHERENCE_ESCALATION_THRESHOLD = 0.6;

/**
 * Idempotently mark a CommunicationAdherence row as escalated when its
 * overall is below the threshold. No-op if already escalated, so this is
 * safe to call from both the drafted-then-sent path and the synthesised
 * bypassed-send path.
 */
export async function escalateAdherenceIfPoor(input: {
  tenantId: string;
  adherenceId: string;
  overall: number;
  draftId: string;
  membershipId: string;
}): Promise<{ escalated: boolean }> {
  if (input.overall >= ADHERENCE_ESCALATION_THRESHOLD) return { escalated: false };

  const existing = await superDb.communicationAdherence.findUnique({
    where: { id: input.adherenceId },
    select: { escalatedAt: true },
  });
  if (!existing || existing.escalatedAt) return { escalated: false };

  await superDb.communicationAdherence.update({
    where: { id: input.adherenceId },
    data: { escalatedAt: new Date() },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "ADHERENCE_ESCALATED",
    actorMembershipId: null,
    subjectType: "CommunicationAdherence",
    subjectId: input.adherenceId,
    payload: {
      draftId: input.draftId,
      membershipId: input.membershipId,
      overall: input.overall,
      threshold: ADHERENCE_ESCALATION_THRESHOLD,
    },
  });

  // Backlog item 6 — immediate notification to the sender + the FCT lane.
  // Idempotent on adherenceId so the escalation that fires from both the
  // drafted-then-sent path and the bypassed-send synthesis path can never
  // double-mail. Failures are logged but don't bubble — the
  // CommunicationAdherence row + audit event are the load-bearing artefacts.
  const tenant = await superDb.tenant.findUnique({
    where: { id: input.tenantId },
    select: { slug: true },
  });
  if (tenant) {
    try {
      await dispatchAdherenceEscalation({
        tenantId: input.tenantId,
        tenantSlug: tenant.slug,
        adherenceId: input.adherenceId,
        draftId: input.draftId,
        membershipId: input.membershipId,
        overall: input.overall,
        threshold: ADHERENCE_ESCALATION_THRESHOLD,
      });
    } catch (e) {
      reportError(e, {
        route: "adherence.escalate",
        tenantId: input.tenantId,
        extra: { adherenceId: input.adherenceId },
      });
    }
  }

  return { escalated: true };
}
