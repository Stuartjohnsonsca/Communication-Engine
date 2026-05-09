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
  requirePermission(ctx.membership.role, "ucg:write:self");

  const ucg = await superDb.userCultureGuide.findFirst({
    where: { id, tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
    include: { rulings: true },
  });
  if (!ucg) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Block commit if a Judge ruling has any blocking failure
  if (ucg.judgeStatus !== "pass" && ucg.judgeStatus !== "partial") {
    return NextResponse.json(
      { error: `UCG cannot be committed (judgeStatus=${ucg.judgeStatus ?? "not run"}). Run Judge first.` },
      { status: 409 },
    );
  }
  const blocking = ucg.rulings.filter((r) => r.severity === "blocking" && r.verdict === "FAIL");
  if (blocking.length > 0) {
    return NextResponse.json(
      { error: "UCG has blocking compliance failures", failures: blocking.length },
      { status: 409 },
    );
  }

  // Mark prior committed-or-conflicted UCGs for this user as SUPERSEDED.
  // Including CONFLICTED here is how users resolve a §5.2.2 conflict: they
  // commit a new UCG version that judges clean against the new FCG, and the
  // old conflicted version is superseded.
  await superDb.userCultureGuide.updateMany({
    where: {
      membershipId: ctx.membership.id,
      status: { in: ["COMMITTED", "CONFLICTED"] },
      id: { not: ucg.id },
    },
    data: { status: "SUPERSEDED" },
  });
  const updated = await superDb.userCultureGuide.update({
    where: { id: ucg.id },
    data: {
      status: "COMMITTED",
      committedAt: new Date(),
      conflictedSinceFcgId: null,
      conflictFlaggedAt: null,
      gracePeriodEndsAt: null,
      conflictAutoSuspendedAt: null,
    },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "UCG_COMMITTED",
    actorMembershipId: ctx.membership.id,
    subjectType: "UserCultureGuide",
    subjectId: updated.id,
    payload: { version: updated.version, basedOnFcgId: updated.basedOnFcgId },
  });

  return NextResponse.json(updated);
}
