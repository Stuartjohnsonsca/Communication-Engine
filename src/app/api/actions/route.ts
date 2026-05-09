import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";

const inputSchema = z.object({
  tenantSlug: z.string(),
  title: z.string().trim().min(1).max(280),
  detail: z.string().trim().max(2000).optional(),
  type: z.enum(["task", "calendar", "followup", "research"]).default("task"),
  dueAt: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "draft:create");

  const action = await superDb.action.create({
    data: {
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      title: parsed.data.title,
      detail: parsed.data.detail || null,
      type: parsed.data.type,
      dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
      status: "OPEN",
    },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "ACTION_CREATED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Action",
    subjectId: action.id,
    payload: { type: action.type, source: "manual" },
  });

  return NextResponse.json(action);
}
