import type { Prisma } from "@prisma/client";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { scoreAdherence } from "@/lib/ai/agents/adherenceAgent";
import { escalateAdherenceIfPoor } from "./escalation";
import { reportError } from "@/lib/observability";

/**
 * Backlog item 1 — bypassed-send detection.
 *
 * The Communication Engine drafts but never sends. Every send (drafted or
 * bypassed) must be observed and scored. The drafted-then-sent path lives
 * at /api/drafts/[id]/sent. This module covers the bypassed path: when
 * channel ingest observes an OUT message, we either link it to an
 * existing SENT Draft (the User sent the draft we generated, possibly
 * with edits) or synthesise a new SENT Draft so the score still happens.
 *
 * Match rule for "this OUT message is just the SENT verbatim of an
 * existing Draft": same membership, status SENT, marked sent within the
 * last 7 days, and either `body` or `sentText` byte-equal to the OUT
 * body. Anything looser would invite false positives that silently skip
 * scoring; anything tighter would synthesise a duplicate Draft for an
 * already-scored send. Edited-and-sent (where text differs) is treated
 * as bypassed deliberately — the User reached outside our UI to change
 * the words, so the score against the actually-sent text is what matters.
 */

const MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const KIND_TO_COMM_CHANNEL: Record<string, string> = {
  M365: "EMAIL",
  GOOGLE: "EMAIL",
  TEAMS: "TEAMS",
  SLACK: "SLACK",
  WHATSAPP_BUSINESS: "WHATSAPP_BUSINESS",
};

const COMM_CHANNEL_LABEL: Record<string, string> = {
  EMAIL: "email",
  SLACK: "slack",
  TEAMS: "teams",
  LETTER: "letter",
  REPORT: "report",
  WHATSAPP_BUSINESS: "whatsapp_business",
  ANY: "any",
};

/**
 * Best-effort attribution: try to attach the OUT message to an existing
 * SENT Draft for the connected User. If matched, links and returns. If
 * unmatched (or no connected User), synthesises a forensic SENT Draft
 * and scores it. Never throws — adherence is a non-blocking enrichment
 * on ingest.
 */
export async function synthesiseFromOutbound(
  channelId: string,
  ingestedMessageId: string,
): Promise<
  | { result: "matched"; draftId: string }
  | { result: "synthesised"; draftId: string; adherenceId: string | null; escalated: boolean }
  | { result: "skipped"; reason: string }
> {
  const ingested = await superDb.ingestedMessage.findUnique({
    where: { id: ingestedMessageId },
  });
  if (!ingested || ingested.direction !== "OUT") {
    return { result: "skipped", reason: "not an outbound ingest" };
  }

  // Already linked to a draft — nothing to do.
  const alreadyLinked = await superDb.draft.findFirst({
    where: { outboundIngestedMessageId: ingestedMessageId },
    select: { id: true },
  });
  if (alreadyLinked) {
    return { result: "matched", draftId: alreadyLinked.id };
  }

  // Need a connected User to attribute the send to. Without one we can't
  // assign a UCG version, can't notify on escalation, and would be
  // synthesising "anonymous" sends — fail soft.
  const channel = await superDb.channel.findUnique({
    where: { id: channelId },
    select: { id: true, kind: true, tenantId: true },
  });
  if (!channel) return { result: "skipped", reason: "channel not found" };

  const auth = await superDb.channelAuth.findFirst({
    where: { channelId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  const membershipId = auth?.membershipId ?? null;
  if (!membershipId) {
    return { result: "skipped", reason: "no authenticated membership on channel" };
  }

  const sentAt = ingested.sentAt ?? ingested.createdAt;
  const windowStart = new Date(sentAt.getTime() - MATCH_WINDOW_MS);

  // Match step: a SENT draft for this membership with body or sentText
  // byte-equal to the observed OUT body. Newest first so re-sends pin to
  // the most recent attempt.
  const candidate = await superDb.draft.findFirst({
    where: {
      tenantId: channel.tenantId,
      membershipId,
      status: "SENT",
      outboundIngestedMessageId: null,
      sentMarkedAt: { gte: windowStart },
      OR: [
        { body: ingested.body },
        { sentText: ingested.body },
      ],
    },
    orderBy: { sentMarkedAt: "desc" },
    select: { id: true },
  });

  if (candidate) {
    await superDb.draft.update({
      where: { id: candidate.id },
      data: { outboundIngestedMessageId: ingestedMessageId },
    });
    return { result: "matched", draftId: candidate.id };
  }

  // Synthesise. Find the most recent IN message in the same thread (if any)
  // so the adherence judge has the inbound it was responding to.
  const inbound = ingested.threadId
    ? await superDb.ingestedMessage.findFirst({
        where: {
          tenantId: channel.tenantId,
          channelId,
          threadId: ingested.threadId,
          direction: "IN",
          sentAt: { lte: sentAt },
        },
        orderBy: { sentAt: "desc" },
      })
    : null;

  const fcg = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: channel.tenantId, status: "COMMITTED" },
    include: { rules: true },
    orderBy: { version: "desc" },
  });
  const ucg = await superDb.userCultureGuide.findFirst({
    where: {
      tenantId: channel.tenantId,
      membershipId,
      status: { in: ["COMMITTED", "CONFLICTED"] },
    },
    include: { rules: { where: { suspendedAt: null } } },
    orderBy: { version: "desc" },
  });

  const commChannel = KIND_TO_COMM_CHANNEL[channel.kind] ?? "EMAIL";

  const responseLatencyMin = inbound?.sentAt
    ? Math.max(0, Math.round((sentAt.getTime() - inbound.sentAt.getTime()) / 60000))
    : null;

  const draft = await superDb.draft.create({
    data: {
      tenantId: channel.tenantId,
      membershipId,
      status: "SENT",
      kind: "EMAIL",
      channel: commChannel as "EMAIL" | "SLACK" | "TEAMS" | "LETTER" | "REPORT" | "WHATSAPP_BUSINESS" | "ANY",
      language: "en-GB",
      subject: ingested.subject,
      body: ingested.body,
      synthesisedFromOutboundIngest: true,
      outboundIngestedMessageId: ingested.id,
      ingestedMessageId: inbound?.id ?? null,
      inboundChannel: inbound ? commChannel : null,
      inboundSender: inbound?.sender ?? null,
      inboundSubject: inbound?.subject ?? null,
      inboundBody: inbound?.body ?? null,
      sentMarkedAt: sentAt,
      sentText: ingested.body,
      sentResponseLatencyMin: responseLatencyMin,
      fcgVersionUsed: fcg?.version ?? null,
      ucgVersionUsed: ucg?.version ?? null,
    },
  });

  await writeAuditEvent({
    tenantId: channel.tenantId,
    eventType: "DRAFT_SYNTHESISED_FROM_OUTBOX",
    actorMembershipId: membershipId,
    subjectType: "Draft",
    subjectId: draft.id,
    payload: {
      ingestedMessageId: ingested.id,
      threadId: ingested.threadId,
      channelKind: channel.kind,
      hadInboundContext: !!inbound,
    },
  });

  // Score. If we have no FCG yet (a tenant pre-FCG) we cannot judge.
  if (!fcg) {
    return { result: "synthesised", draftId: draft.id, adherenceId: null, escalated: false };
  }

  const fcgJson = {
    version: fcg.version,
    rules: fcg.rules.map((r) => ({
      externalId: r.externalId,
      category: r.category,
      channel: r.channel,
      statement: r.statement,
      payload: r.payload,
      mandatory: r.mandatory,
      channelOverrides: r.channelOverrides,
    })),
  };
  const ucgJson = ucg
    ? {
        version: ucg.version,
        rules: ucg.rules.map((r) => ({
          externalId: r.externalId,
          category: r.category,
          channel: r.channel,
          statement: r.statement,
          payload: r.payload,
          narrowsFcgRule: r.narrowsFcgRule,
        })),
      }
    : { version: 0, rules: [] };

  let scored: Awaited<ReturnType<typeof scoreAdherence>> | null = null;
  try {
    scored = await scoreAdherence({
      tenantId: channel.tenantId,
      fcg: fcgJson,
      ucg: ucgJson,
      channel: COMM_CHANNEL_LABEL[commChannel] ?? "email",
      inbound: inbound
        ? { sender: inbound.sender, subject: inbound.subject, body: inbound.body }
        : undefined,
      sent: { subject: ingested.subject, body: ingested.body },
      responseLatencyMin,
      // Item 55 — bypassed-send synthesis path. No User actor; the
      // adherence call was triggered by an OUT IngestedMessage with
      // no matching draft. Context distinguishes from explicit
      // /api/drafts/[id]/sent spend.
      record: {
        tenantId: channel.tenantId,
        context: "adherence-synthesised",
        membershipId: null,
      },
    });
  } catch (e) {
    reportError(e, {
      route: "lib/adherence/synthesise",
      tenantId: channel.tenantId,
      extra: { ingestedMessageId: ingested.id },
    }, "synthesised adherence scoring failed");
  }

  if (!scored) {
    return { result: "synthesised", draftId: draft.id, adherenceId: null, escalated: false };
  }

  const adherence = await superDb.communicationAdherence.create({
    data: {
      tenantId: channel.tenantId,
      draftId: draft.id,
      membershipId,
      fcgVersionUsed: fcg.version,
      ucgVersionUsed: ucg?.version ?? null,
      overall: scored.result.overall,
      perDimension: scored.result.perDimension as unknown as Prisma.InputJsonValue,
      perRule: scored.result.perRule as unknown as Prisma.InputJsonValue,
      modelRunId: scored.modelRunId ?? null,
    },
  });

  await writeAuditEvent({
    tenantId: channel.tenantId,
    eventType: "ADHERENCE_SCORED",
    actorMembershipId: membershipId,
    subjectType: "Draft",
    subjectId: draft.id,
    payload: {
      overall: scored.result.overall,
      fcgVersionUsed: fcg.version,
      ucgVersionUsed: ucg?.version ?? null,
      synthesised: true,
    },
  });

  const { escalated } = await escalateAdherenceIfPoor({
    tenantId: channel.tenantId,
    adherenceId: adherence.id,
    overall: scored.result.overall,
    draftId: draft.id,
    membershipId,
  });

  return { result: "synthesised", draftId: draft.id, adherenceId: adherence.id, escalated };
}
