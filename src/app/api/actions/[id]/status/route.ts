import { NextResponse } from "next/server";
import { z } from "zod";
import type { AuditEventType } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";

const inputSchema = z.object({
  tenantSlug: z.string(),
  status: z.enum(["COMPLETED", "DISMISSED", "OPEN"]),
});

const eventByStatus: Record<"COMPLETED" | "DISMISSED" | "OPEN", AuditEventType> = {
  COMPLETED: "ACTION_COMPLETED",
  DISMISSED: "ACTION_DISMISSED",
  OPEN: "ACTION_REOPENED",
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "draft:create");

  const existing = await superDb.action.findFirst({
    where: { id, tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
  });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const next = parsed.data.status;
  if (existing.status === next) return NextResponse.json(existing);

  const updated = await superDb.action.update({
    where: { id },
    data: {
      status: next,
      completedAt: next === "COMPLETED" ? new Date() : null,
    },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: eventByStatus[next],
    actorMembershipId: ctx.membership.id,
    subjectType: "Action",
    subjectId: updated.id,
    payload: { from: existing.status, to: next },
  });

  return NextResponse.json(updated);
}
