import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";
import { scoreAdherence } from "@/lib/ai/agents/adherenceAgent";
import type { Prisma } from "@prisma/client";

const inputSchema = z.object({
  tenantSlug: z.string(),
  /** Optional: the user's actual sent text. Defaults to the current draft body
   *  if omitted (i.e. the user is confirming they sent the draft as-is). */
  sentText: z.string().min(1).max(50000).optional(),
  sentSubject: z.string().max(500).nullable().optional(),
});

const channelLabel: Record<string, string> = {
  EMAIL: "email",
  SLACK: "slack",
  TEAMS: "teams",
  LETTER: "letter",
  REPORT: "report",
  WHATSAPP_BUSINESS: "whatsapp_business",
  ANY: "any",
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "draft:create");

  const draft = await superDb.draft.findFirst({
    where: { id, tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
    include: { ingestedMessage: true },
  });
  if (!draft) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (draft.status === "SENT") {
    return NextResponse.json({ error: "draft already sent" }, { status: 409 });
  }

  const sentSubject =
    parsed.data.sentSubject !== undefined ? parsed.data.sentSubject : draft.subject;
  const sentText = parsed.data.sentText ?? draft.body;
  const sentAt = new Date();

  // Response latency relative to inbound receipt, if we know one.
  const inboundAt = draft.ingestedMessage?.sentAt ?? null;
  const responseLatencyMin = inboundAt
    ? Math.max(0, Math.round((sentAt.getTime() - inboundAt.getTime()) / 60000))
    : null;

  // Load the FCG + UCG that this draft was produced against, so the adherence
  // verdict is anchored to the same versions the user saw at draft-time.
  const fcg = await superDb.firmCultureGuide.findFirst({
    where: {
      tenantId: ctx.tenant.id,
      ...(draft.fcgVersionUsed != null
        ? { version: draft.fcgVersionUsed }
        : { status: "COMMITTED" }),
    },
    include: { rules: true },
    orderBy: { version: "desc" },
  });

  const ucg = await superDb.userCultureGuide.findFirst({
    where: {
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      ...(draft.ucgVersionUsed != null
        ? { version: draft.ucgVersionUsed }
        : { status: { in: ["COMMITTED", "CONFLICTED"] } }),
    },
    include: { rules: { where: { suspendedAt: null } } },
    orderBy: { version: "desc" },
  });

  // Persist the sent text first — even if scoring fails, the lifecycle moves
  // forward. Adherence becomes a failed-soft enrichment in that case.
  const updated = await superDb.draft.update({
    where: { id },
    data: {
      status: "SENT",
      sentMarkedAt: sentAt,
      sentText,
      subject: sentSubject ?? draft.subject,
      sentResponseLatencyMin: responseLatencyMin,
    },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "DRAFT_SENT_MARKED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Draft",
    subjectId: updated.id,
    payload: {
      responseLatencyMin,
      diverged: sentText !== draft.body,
    },
  });

  if (!fcg) {
    // No FCG → cannot score. Surface the SENT update without an adherence row.
    return NextResponse.json({ draft: updated, adherence: null });
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
      tenantId: ctx.tenant.id,
      fcg: fcgJson,
      ucg: ucgJson,
      channel: channelLabel[draft.channel] ?? "email",
      inbound: {
        sender: draft.inboundSender ?? draft.ingestedMessage?.sender ?? null,
        subject: draft.inboundSubject ?? draft.ingestedMessage?.subject ?? null,
        body: draft.inboundBody ?? draft.ingestedMessage?.body ?? null,
      },
      sent: { subject: sentSubject, body: sentText },
      responseLatencyMin,
    });
  } catch (e) {
    console.error("adherence scoring failed", e);
  }

  if (!scored) {
    return NextResponse.json({ draft: updated, adherence: null });
  }

  const created = await superDb.communicationAdherence.create({
    data: {
      tenantId: ctx.tenant.id,
      draftId: updated.id,
      membershipId: ctx.membership.id,
      fcgVersionUsed: fcg.version,
      ucgVersionUsed: ucg?.version ?? null,
      overall: scored.result.overall,
      perDimension: scored.result.perDimension as unknown as Prisma.InputJsonValue,
      perRule: scored.result.perRule as unknown as Prisma.InputJsonValue,
      modelRunId: scored.modelRunId ?? null,
    },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "ADHERENCE_SCORED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Draft",
    subjectId: updated.id,
    payload: {
      overall: scored.result.overall,
      fcgVersionUsed: fcg.version,
      ucgVersionUsed: ucg?.version ?? null,
    },
  });

  return NextResponse.json({ draft: updated, adherence: created });
}
