import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";

const inputSchema = z.object({ tenantSlug: z.string() });

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
  });
  if (!draft) return NextResponse.json({ error: "not found" }, { status: 404 });

  const updated = await superDb.draft.update({
    where: { id },
    data: { status: "SENT", sentMarkedAt: new Date() },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "DRAFT_SENT_MARKED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Draft",
    subjectId: updated.id,
    payload: {},
  });

  return NextResponse.json(updated);
}
