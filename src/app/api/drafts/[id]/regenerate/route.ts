import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { produceDraft } from "@/lib/ai/agents/draftAgent";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";
import { getMemberLifecycleState, isDraftingPermitted } from "@/lib/lifecycle";

const inputSchema = z.object({ tenantSlug: z.string() });

const channelEnum: Record<string, "EMAIL" | "SLACK" | "TEAMS" | "LETTER" | "REPORT" | "WHATSAPP_BUSINESS" | "ANY"> = {
  email: "EMAIL", slack: "SLACK", teams: "TEAMS", letter: "LETTER", report: "REPORT", whatsapp_business: "WHATSAPP_BUSINESS", any: "ANY",
};
const draftKindMap: Record<string, "EMAIL" | "HOLDING" | "TECHNICAL" | "ACTION_ONLY"> = {
  substantive: "EMAIL", holding: "HOLDING", technical: "TECHNICAL", holding_research: "HOLDING",
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "draft:create");

  // PRD §14.3: regeneration is drafting; same gate.
  const lifecycle = getMemberLifecycleState(ctx.membership);
  if (!isDraftingPermitted(lifecycle)) {
    return NextResponse.json(
      { error: "drafting_halted", lifecycle: lifecycle.kind },
      { status: 409 },
    );
  }

  const existing = await superDb.draft.findFirst({
    where: { id, tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
    include: { ingestedMessage: true },
  });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.status === "SENT") {
    return NextResponse.json({ error: "cannot regenerate a sent draft" }, { status: 409 });
  }

  // Source the inbound from the snapshot stored on the draft, falling back
  // to the linked IngestedMessage if present (older drafts pre-snapshot).
  const inboundChannel = existing.inboundChannel ?? "email";
  const inboundSender =
    existing.inboundSender ?? existing.ingestedMessage?.sender ?? undefined;
  const inboundSubject =
    existing.inboundSubject ?? existing.ingestedMessage?.subject ?? undefined;
  const inboundBody = existing.inboundBody ?? existing.ingestedMessage?.body;
  if (!inboundBody) {
    return NextResponse.json(
      { error: "no inbound stored on this draft — cannot regenerate" },
      { status: 409 },
    );
  }

  const fcg = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: ctx.tenant.id, status: "COMMITTED" },
    include: { rules: true },
    orderBy: { version: "desc" },
  });
  if (!fcg) return NextResponse.json({ error: "no committed FCG" }, { status: 409 });

  const ucg = await superDb.userCultureGuide.findFirst({
    where: {
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      status: { in: ["COMMITTED", "CONFLICTED"] },
    },
    include: { rules: { where: { suspendedAt: null } } },
    orderBy: { version: "desc" },
  });

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

  const noGo = await superDb.noGoSubject.findMany({ where: { tenantId: ctx.tenant.id } });

  const draft = await produceDraft({
    tenantId: ctx.tenant.id,
    fcg: fcgJson,
    ucg: ucgJson,
    inbound: {
      channel: inboundChannel,
      sender: inboundSender,
      subject: inboundSubject,
      body: inboundBody,
    },
    noGoSubjects: noGo.map((n) => n.label),
  });

  type ActionCreate = {
    tenantId: string;
    membershipId: string;
    title: string;
    detail: string | null;
    type: "task" | "calendar" | "followup" | "research";
    dueAt: Date | null;
  };
  const llmActions: ActionCreate[] = draft.actions.map((a) => ({
    tenantId: ctx.tenant.id,
    membershipId: ctx.membership.id,
    title: a.title,
    detail: a.detail ?? null,
    type: a.type,
    dueAt: a.dueAt ? new Date(a.dueAt) : null,
  }));
  const synthesised: ActionCreate[] = [];
  const subjectLabel = inboundSubject?.trim() || "(no subject)";
  if (draft.holdingRequired && !llmActions.some((a) => a.type === "followup")) {
    synthesised.push({
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      title: `Send substantive follow-up: ${subjectLabel}`,
      detail: draft.holdingReason ?? null,
      type: "followup",
      dueAt: draft.fcgWindowDeadline ? new Date(draft.fcgWindowDeadline) : null,
    });
  }
  if (draft.researchTaskRequired && !llmActions.some((a) => a.type === "research")) {
    synthesised.push({
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      title: `Research before responding: ${subjectLabel}`,
      detail: null,
      type: "research",
      dueAt: null,
    });
  }

  // Discard the prior draft and chain the new one off it via parentId so
  // the audit + UI can show the regeneration lineage.
  const [created] = await superDb.$transaction([
    superDb.draft.create({
      data: {
        tenantId: ctx.tenant.id,
        membershipId: ctx.membership.id,
        ingestedMessageId: existing.ingestedMessageId,
        parentId: existing.id,
        kind: draftKindMap[draft.type] ?? "EMAIL",
        channel: channelEnum[draft.channel] ?? "EMAIL",
        language: draft.language,
        subject: draft.subject ?? null,
        body: draft.body,
        citations: draft.citations as never,
        holdingRequired: draft.holdingRequired,
        holdingReason: draft.holdingReason ?? null,
        fcgWindowDeadline: draft.fcgWindowDeadline ? new Date(draft.fcgWindowDeadline) : null,
        noGoSubjectHit: draft.noGoSubjectHit,
        researchTaskRequired: draft.researchTaskRequired,
        fcgVersionUsed: fcg.version,
        ucgVersionUsed: ucg?.version ?? null,
        inboundChannel,
        inboundSender: inboundSender ?? null,
        inboundSubject: inboundSubject ?? null,
        inboundBody,
        actions: {
          create: [...llmActions, ...synthesised],
        },
      },
      include: { actions: true },
    }),
    superDb.draft.update({
      where: { id: existing.id },
      data: { status: "DISCARDED" },
    }),
  ]);

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "DRAFT_REGENERATED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Draft",
    subjectId: created.id,
    payload: {
      parentId: existing.id,
      kind: created.kind,
      actions: created.actions.length,
      autoSpawnedActions: synthesised.length,
    },
  });

  return NextResponse.json({ draft: created });
}
