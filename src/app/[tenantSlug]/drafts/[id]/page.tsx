import { notFound, redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import DraftDetailClient, {
  type DraftDetail,
  type AdherenceDetail,
  type SentimentDetail,
} from "./DraftDetailClient";

export default async function DraftDetailPage({
  params,
}: {
  params: Promise<{ tenantSlug: string; id: string }>;
}) {
  const { tenantSlug, id } = await params;
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) redirect("/login");

  const draft = await superDb.draft.findFirst({
    where: { id, tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
    include: {
      actions: { orderBy: { createdAt: "asc" } },
      adherence: true,
      parent: { select: { id: true, status: true, createdAt: true } },
      children: {
        select: { id: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!draft) notFound();

  const sentiment = draft.ingestedMessageId
    ? await superDb.sentimentSignal.findFirst({
        where: { tenantId: ctx.tenant.id, ingestedMessageId: draft.ingestedMessageId },
        orderBy: { createdAt: "desc" },
      })
    : null;

  const detail: DraftDetail = {
    id: draft.id,
    kind: draft.kind,
    status: draft.status,
    channel: draft.channel,
    language: draft.language,
    subject: draft.subject,
    body: draft.body,
    citations: (draft.citations ?? []) as DraftDetail["citations"],
    holdingRequired: draft.holdingRequired,
    holdingReason: draft.holdingReason,
    fcgWindowDeadline: draft.fcgWindowDeadline?.toISOString() ?? null,
    noGoSubjectHit: draft.noGoSubjectHit,
    researchTaskRequired: draft.researchTaskRequired,
    fcgVersionUsed: draft.fcgVersionUsed,
    ucgVersionUsed: draft.ucgVersionUsed,
    inboundChannel: draft.inboundChannel,
    inboundSender: draft.inboundSender,
    inboundSubject: draft.inboundSubject,
    inboundBody: draft.inboundBody,
    createdAt: draft.createdAt.toISOString(),
    sentMarkedAt: draft.sentMarkedAt?.toISOString() ?? null,
    sentText: draft.sentText,
    sentResponseLatencyMin: draft.sentResponseLatencyMin,
    adherence: draft.adherence
      ? ({
          overall: draft.adherence.overall,
          perDimension: draft.adherence.perDimension,
          perRule: draft.adherence.perRule,
          fcgVersionUsed: draft.adherence.fcgVersionUsed,
          ucgVersionUsed: draft.adherence.ucgVersionUsed,
          createdAt: draft.adherence.createdAt.toISOString(),
        } as AdherenceDetail)
      : null,
    actions: draft.actions.map((a) => ({
      id: a.id,
      title: a.title,
      detail: a.detail,
      type: a.type,
      status: a.status,
      dueAt: a.dueAt?.toISOString() ?? null,
    })),
    parent: draft.parent
      ? {
          id: draft.parent.id,
          status: draft.parent.status,
          createdAt: draft.parent.createdAt.toISOString(),
        }
      : null,
    children: draft.children.map((c) => ({
      id: c.id,
      status: c.status,
      createdAt: c.createdAt.toISOString(),
    })),
    sentiment: sentiment
      ? ({
          id: sentiment.id,
          classification: sentiment.classification,
          confidence: sentiment.confidence,
          isAboutFirmHandling: sentiment.isAboutFirmHandling,
          trigger: sentiment.trigger,
          escalatedAt: sentiment.escalatedAt?.toISOString() ?? null,
          acknowledgedAt: sentiment.acknowledgedAt?.toISOString() ?? null,
          evidenceSpans:
            (sentiment.evidence as { spans?: { text: string }[] } | null)?.spans ?? [],
        } as SentimentDetail)
      : null,
  };

  return <DraftDetailClient tenantSlug={tenantSlug} draft={detail} />;
}
