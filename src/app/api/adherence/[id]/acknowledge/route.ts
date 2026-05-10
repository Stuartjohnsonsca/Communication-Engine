import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { hasPermission, requirePermission } from "@/lib/rbac";

const inputSchema = z.object({ tenantSlug: z.string() });

/**
 * Backlog item 1 — acknowledge an adherence escalation. Mirrors the
 * sentiment acknowledge route at /api/sentiment/[id]/acknowledge.
 *
 * Permission: the assignee (= the row's `membershipId`, i.e. the User
 * whose send was scored) OR any FCT / FIRM_ADMIN exercising firm-wide
 * oversight. Acknowledging records ownership and lets the queue clear;
 * it does NOT alter the score itself.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "adherence:acknowledge");

  const row = await superDb.communicationAdherence.findFirst({
    where: { id, tenantId: ctx.tenant.id },
  });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const isAssignee = row.membershipId === ctx.membership.id;
  const isFctOrAdmin = hasPermission(ctx.membership.role, "members:read");
  if (!isAssignee && !isFctOrAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (row.acknowledgedAt) {
    // Idempotent — return current state without a new audit event.
    return NextResponse.json(row);
  }

  if (!row.escalatedAt) {
    return NextResponse.json({ error: "not escalated" }, { status: 409 });
  }

  const updated = await superDb.communicationAdherence.update({
    where: { id },
    data: {
      acknowledgedAt: new Date(),
      acknowledgedById: ctx.membership.id,
    },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "ADHERENCE_ACKNOWLEDGED",
    actorMembershipId: ctx.membership.id,
    subjectType: "CommunicationAdherence",
    subjectId: updated.id,
    payload: {
      draftId: updated.draftId,
      assignedToMembershipId: updated.membershipId,
      overall: updated.overall,
    },
  });

  return NextResponse.json(updated);
}
