import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { produceMeetingPaper } from "@/lib/ai/agents/meetingPaperAgent";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";

const generateSchema = z.object({ tenantSlug: z.string() });

const editSchema = z.object({
  tenantSlug: z.string(),
  paperBody: z.string().min(1).max(100000).optional(),
  agenda: z
    .array(
      z.object({
        item: z.string().min(1).max(200),
        durationMin: z.number().int().min(1).max(240).nullable().optional(),
        owner: z.string().max(120).nullable().optional(),
      }),
    )
    .min(1)
    .max(20)
    .optional(),
  openQuestions: z.array(z.string().max(400)).max(20).optional(),
});

/** POST = generate (or regenerate) the paper. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "meeting:write");

  const meeting = await superDb.meeting.findFirst({
    where: { id, tenantId: ctx.tenant.id },
    include: { participants: true },
  });
  if (!meeting) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Paper-author or an FCT/admin can (re)generate.
  const isAuthor = meeting.paperAuthorMembershipId === ctx.membership.id;
  const isAdmin = ctx.membership.role === "FIRM_ADMIN" || ctx.membership.role === "FCT_MEMBER";
  if (!isAuthor && !isAdmin) {
    return NextResponse.json({ error: "only the paper-author can generate the paper" }, { status: 403 });
  }

  if (meeting.paperStatus === "ISSUED") {
    return NextResponse.json({ error: "paper already issued" }, { status: 409 });
  }

  const fcg = await superDb.firmCultureGuide.findFirst({
    where: { tenantId: ctx.tenant.id, status: "COMMITTED" },
    include: { rules: true },
    orderBy: { version: "desc" },
  });
  if (!fcg) return NextResponse.json({ error: "no committed FCG" }, { status: 409 });

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

  const paperAuthorName =
    (await superDb.membership
      .findUnique({
        where: { id: meeting.paperAuthorMembershipId ?? "" },
        include: { user: true },
      })
      .then((m) => m?.user.name ?? m?.user.email))
    ?? "Chair";

  const isRegenerate = meeting.paperStatus !== "NONE";

  const { result, modelRunId } = await produceMeetingPaper({
    tenantId: ctx.tenant.id,
    fcg: fcgJson,
    meeting: {
      title: meeting.title,
      description: meeting.description,
      location: meeting.location,
      startsAt: meeting.startsAt.toISOString(),
      durationMin: meeting.durationMin,
      paperAuthor: paperAuthorName,
      shortNotice: meeting.shortNotice,
      leadTimeWorkingDays: meeting.leadTimeWorkingDays,
    },
    participants: meeting.participants.map((p) => ({
      name: p.name,
      email: p.email,
      isExternal: p.isExternal,
      isMeetingCreator: p.isMeetingCreator,
    })),
  });

  const updated = await superDb.meeting.update({
    where: { id: meeting.id },
    data: {
      paperStatus: "DRAFTED",
      agenda: result.agenda as never,
      paperBody: result.paper,
      openQuestions: result.openQuestions as never,
      paperGeneratedAt: new Date(),
      paperFcgVersionUsed: fcg.version,
      paperModelRunId: modelRunId ?? null,
    },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: isRegenerate ? "MEETING_PAPER_REGENERATED" : "MEETING_PAPER_DRAFTED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Meeting",
    subjectId: meeting.id,
    payload: {
      fcgVersionUsed: fcg.version,
      agendaItems: result.agenda.length,
      openQuestions: result.openQuestions.length,
      shortNotice: meeting.shortNotice,
    },
  });

  return NextResponse.json({ meeting: updated });
}

/** PATCH = the paper-author edits the paper body / agenda / questions. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = editSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "meeting:write");

  const existing = await superDb.meeting.findFirst({
    where: { id, tenantId: ctx.tenant.id },
  });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.paperStatus === "NONE") {
    return NextResponse.json({ error: "no paper to edit yet — generate first" }, { status: 409 });
  }
  if (existing.paperStatus === "ISSUED") {
    return NextResponse.json({ error: "paper already issued" }, { status: 409 });
  }

  const isAuthor = existing.paperAuthorMembershipId === ctx.membership.id;
  const isAdmin = ctx.membership.role === "FIRM_ADMIN" || ctx.membership.role === "FCT_MEMBER";
  if (!isAuthor && !isAdmin) {
    return NextResponse.json({ error: "only the paper-author can edit the paper" }, { status: 403 });
  }

  const bodyChanged =
    parsed.data.paperBody !== undefined && parsed.data.paperBody !== existing.paperBody;
  const agendaChanged = parsed.data.agenda !== undefined;
  const questionsChanged = parsed.data.openQuestions !== undefined;
  if (!bodyChanged && !agendaChanged && !questionsChanged) {
    return NextResponse.json({ meeting: existing });
  }

  const updated = await superDb.meeting.update({
    where: { id },
    data: {
      paperBody: parsed.data.paperBody ?? existing.paperBody,
      agenda: agendaChanged ? (parsed.data.agenda as never) : existing.agenda ?? undefined,
      openQuestions: questionsChanged
        ? (parsed.data.openQuestions as never)
        : existing.openQuestions ?? undefined,
      paperStatus: "EDITED",
    },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "MEETING_PAPER_EDITED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Meeting",
    subjectId: updated.id,
    payload: { bodyChanged, agendaChanged, questionsChanged },
  });

  return NextResponse.json({ meeting: updated });
}
