import { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { classifySentiment } from "@/lib/ai/agents/sentimentAgent";
import { dispatchSentimentEscalation } from "@/lib/notifications/immediate";
import { reportError } from "@/lib/observability";

export type ClassifyAndRecordInput = {
  tenantId: string;
  /// Membership the inbound is assigned to — typically the draft owner. The
  /// FCT also sees the row via the firm-wide list.
  assignedToMembershipId: string;
  ingestedMessageId: string;
  inbound: {
    channel: string;
    sender?: string | null;
    subject?: string | null;
    body: string;
  };
};

const CLASSIFICATION_DB: Record<
  "extreme_negative" | "extreme_positive" | "neutral",
  "EXTREME_NEG" | "EXTREME_POS" | "NEUTRAL"
> = {
  extreme_negative: "EXTREME_NEG",
  extreme_positive: "EXTREME_POS",
  neutral: "NEUTRAL",
};

/**
 * Classify one inbound and persist the result as a SentimentSignal.
 *
 * `shouldEscalate` from the model is the recommendation; we honour it for
 * extreme-negative-against-firm-handling at confidence >= 0.6 (PRD §9.3
 * boundary). On escalation we set `escalatedAt` and write a separate
 * SENTIMENT_ESCALATED audit event in addition to SENTIMENT_CLASSIFIED.
 *
 * We persist NEUTRAL signals too — they are useful audit context for an
 * inbound that turns out to be a complaint and is later escalated by a
 * human.
 */
export async function classifyAndRecordInbound(input: ClassifyAndRecordInput) {
  const { result, modelRunId } = await classifySentiment(input.inbound);

  // Hard-floor escalation gate: only EXTREME_NEG specifically about firm
  // handling, and only when the model's own confidence clears the bar.
  // Belt-and-braces against a model returning shouldEscalate:true on a
  // counterparty's general displeasure with their own outcome.
  const escalating =
    result.shouldEscalate &&
    result.classification === "extreme_negative" &&
    result.isAboutFirmHandling &&
    (result.confidence ?? 0) >= 0.6;

  const dbClass = CLASSIFICATION_DB[result.classification];

  const evidenceJson: Prisma.InputJsonValue = {
    spans: result.evidenceSpans,
  };

  const signal = await superDb.sentimentSignal.create({
    data: {
      tenantId: input.tenantId,
      ingestedMessageId: input.ingestedMessageId,
      assignedToMembershipId: input.assignedToMembershipId,
      classification: dbClass,
      confidence: result.confidence,
      isAboutFirmHandling: result.isAboutFirmHandling,
      trigger: result.trigger,
      evidence: evidenceJson,
      shouldEscalate: escalating,
      escalatedAt: escalating ? new Date() : null,
      modelRunId: modelRunId ?? null,
    },
  });

  await writeAuditEvent({
    tenantId: input.tenantId,
    eventType: "SENTIMENT_CLASSIFIED",
    actorMembershipId: null,
    subjectType: "SentimentSignal",
    subjectId: signal.id,
    payload: {
      ingestedMessageId: input.ingestedMessageId,
      classification: dbClass,
      confidence: result.confidence,
      isAboutFirmHandling: result.isAboutFirmHandling,
    },
  });

  if (escalating) {
    await writeAuditEvent({
      tenantId: input.tenantId,
      eventType: "SENTIMENT_ESCALATED",
      actorMembershipId: null,
      subjectType: "SentimentSignal",
      subjectId: signal.id,
      payload: {
        assignedToMembershipId: input.assignedToMembershipId,
        trigger: result.trigger,
      },
    });

    // Backlog item 6 — immediate dispatch. Idempotent on signal.id so a
    // re-classification on the same signal can't double-mail.
    const tenant = await superDb.tenant.findUnique({
      where: { id: input.tenantId },
      select: { slug: true },
    });
    if (tenant) {
      try {
        await dispatchSentimentEscalation({
          tenantId: input.tenantId,
          tenantSlug: tenant.slug,
          signalId: signal.id,
          assignedToMembershipId: input.assignedToMembershipId,
          trigger: result.trigger,
          inboundSender: input.inbound.sender ?? null,
        });
      } catch (e) {
        reportError(e, {
          route: "sentiment.escalate",
          tenantId: input.tenantId,
          extra: { signalId: signal.id },
        });
      }
    }
  }

  return signal;
}
