import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { produceDraft } from "@/lib/ai/agents/draftAgent";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";

const inputSchema = z.object({
  tenantSlug: z.string(),
  inbound: z.object({
    channel: z.string().default("email"),
    sender: z.string().optional(),
    subject: z.string().optional(),
    body: z.string(),
    receivedAt: z.string().optional(),
  }),
});

const channelEnum: Record<string, "EMAIL" | "SLACK" | "TEAMS" | "LETTER" | "REPORT" | "WHATSAPP_BUSINESS" | "ANY"> = {
  email: "EMAIL", slack: "SLACK", teams: "TEAMS", letter: "LETTER", report: "REPORT", whatsapp_business: "WHATSAPP_BUSINESS", any: "ANY",
};
const draftKindMap: Record<string, "EMAIL" | "HOLDING" | "TECHNICAL" | "ACTION_ONLY"> = {
  substantive: "EMAIL", holding: "HOLDING", technical: "TECHNICAL", holding_research: "HOLDING",
};

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "draft:create");

  const fcg = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: ctx.tenant.id, status: "COMMITTED" },
    include: { rules: true },
    orderBy: { version: "desc" },
  });
  if (!fcg) return NextResponse.json({ error: "no committed FCG" }, { status: 409 });

  const ucg = await superDb.userCultureGuide.findFirst({
    where: { tenantId: ctx.tenant.id, membershipId: ctx.membership.id, status: "COMMITTED" },
    include: { rules: true },
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
    inbound: parsed.data.inbound,
    noGoSubjects: noGo.map((n) => n.label),
  });

  const created = await superDb.draft.create({
    data: {
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
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
      actions: {
        create: draft.actions.map((a) => ({
          tenantId: ctx.tenant.id,
          membershipId: ctx.membership.id,
          title: a.title,
          detail: a.detail ?? null,
          type: a.type,
          dueAt: a.dueAt ? new Date(a.dueAt) : null,
        })),
      },
    },
    include: { actions: true },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "DRAFT_PRODUCED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Draft",
    subjectId: created.id,
    payload: { kind: created.kind, holdingRequired: created.holdingRequired, actions: created.actions.length },
  });

  return NextResponse.json({ draft: created, output: draft });
}
