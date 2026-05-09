import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";
import { votingWindowMs } from "@/lib/voting/state-machine";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const slug = url.searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "missing tenant" }, { status: 400 });

  const ctx = await getTenantContext(slug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "fcg:propose");

  const proposal = await superDb.fCGProposal.findFirst({
    where: { id, tenantId: ctx.tenant.id },
  });
  if (!proposal) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (proposal.state !== "DRAFTING") {
    return NextResponse.json({ error: `proposal is ${proposal.state}` }, { status: 400 });
  }

  const now = new Date();
  const window = votingWindowMs(proposal.isEmergency, ctx.tenant.votingWindowDays);
  const updated = await superDb.fCGProposal.update({
    where: { id: proposal.id },
    data: {
      state: "OPEN_FOR_VOTE",
      votingOpenedAt: now,
      votingClosesAt: new Date(now.getTime() + window),
    },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "FCG_PROPOSED",
    actorMembershipId: ctx.membership.id,
    subjectType: "FCGProposal",
    subjectId: updated.id,
    payload: {
      title: updated.title,
      isEmergency: updated.isEmergency,
      votingClosesAt: updated.votingClosesAt?.toISOString(),
    },
  });

  return NextResponse.json(updated);
}
