import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { hasPermission } from "@/lib/rbac";

const inputSchema = z.object({ tenantSlug: z.string() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const signal = await superDb.sentimentSignal.findFirst({
    where: { id, tenantId: ctx.tenant.id },
  });
  if (!signal) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Acknowledge is allowed for the assignee, or any FCT member / Firm Admin
  // who is exercising firm-wide oversight (PRD §9.3 escalation routing).
  const isAssignee = signal.assignedToMembershipId === ctx.membership.id;
  const isFctOrAdmin = hasPermission(ctx.membership.role, "members:read");
  if (!isAssignee && !isFctOrAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (signal.acknowledgedAt) {
    // Idempotent — return current state without a new audit event.
    return NextResponse.json(signal);
  }

  const updated = await superDb.sentimentSignal.update({
    where: { id },
    data: {
      acknowledgedAt: new Date(),
      acknowledgedById: ctx.membership.id,
    },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "SENTIMENT_ACKNOWLEDGED",
    actorMembershipId: ctx.membership.id,
    subjectType: "SentimentSignal",
    subjectId: updated.id,
    payload: {
      classification: updated.classification,
      wasEscalated: !!updated.escalatedAt,
    },
  });

  return NextResponse.json(updated);
}
