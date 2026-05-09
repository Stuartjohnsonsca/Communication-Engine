import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";

const inputSchema = z.object({
  tenantSlug: z.string(),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().min(1).max(50000).optional(),
  status: z.enum(["PROPOSED", "EDITED", "ACCEPTED", "DISCARDED"]).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "draft:create");

  const existing = await superDb.draft.findFirst({
    where: { id, tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
  });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (existing.status === "SENT") {
    return NextResponse.json({ error: "draft already sent" }, { status: 409 });
  }

  const subjectChanged =
    parsed.data.subject !== undefined && (parsed.data.subject ?? null) !== (existing.subject ?? null);
  const bodyChanged = parsed.data.body !== undefined && parsed.data.body !== existing.body;
  const explicitStatus = parsed.data.status;

  // If content changed and the caller didn't explicitly transition status,
  // promote PROPOSED → EDITED so the lifecycle reflects the user's edit.
  let nextStatus = explicitStatus ?? existing.status;
  if (!explicitStatus && (subjectChanged || bodyChanged) && existing.status === "PROPOSED") {
    nextStatus = "EDITED";
  }

  const updated = await superDb.draft.update({
    where: { id },
    data: {
      subject: parsed.data.subject !== undefined ? parsed.data.subject : existing.subject,
      body: parsed.data.body ?? existing.body,
      status: nextStatus,
    },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "DRAFT_EDITED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Draft",
    subjectId: updated.id,
    payload: {
      subjectChanged,
      bodyChanged,
      from: { status: existing.status },
      to: { status: updated.status },
    },
  });

  return NextResponse.json(updated);
}
