import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";

const inputSchema = z.object({ tenantSlug: z.string() });

/**
 * Mark the meeting paper as issued (PRD §7.4 — paper-author issues to
 * participants from their native client; we record the action here so the
 * audit trail and the dashboard can show what was sent and when).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "meeting:write");

  const existing = await superDb.meeting.findFirst({
    where: { id, tenantId: ctx.tenant.id },
  });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.paperStatus === "NONE") {
    return NextResponse.json({ error: "no paper to issue" }, { status: 409 });
  }
  if (existing.paperStatus === "ISSUED") {
    return NextResponse.json({ error: "already issued" }, { status: 409 });
  }

  const isAuthor = existing.paperAuthorMembershipId === ctx.membership.id;
  const isAdmin = ctx.membership.role === "FIRM_ADMIN" || ctx.membership.role === "FCT_MEMBER";
  if (!isAuthor && !isAdmin) {
    return NextResponse.json({ error: "only the paper-author can issue the paper" }, { status: 403 });
  }

  const issuedAt = new Date();
  const updated = await superDb.meeting.update({
    where: { id },
    data: { paperStatus: "ISSUED", paperIssuedAt: issuedAt },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "MEETING_PAPER_ISSUED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Meeting",
    subjectId: updated.id,
    payload: {
      issuedAt: issuedAt.toISOString(),
      shortNotice: existing.shortNotice,
      hadEdits: existing.paperStatus === "EDITED",
    },
  });

  return NextResponse.json({ meeting: updated });
}
