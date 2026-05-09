import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { verifyAuditChain, writeAuditEvent } from "@/lib/audit";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "missing tenant" }, { status: 400 });

  const ctx = await getTenantContext(slug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "audit:export");

  const verified = await verifyAuditChain(ctx.tenant.id);
  const events = await superDb.auditEvent.findMany({
    where: { tenantId: ctx.tenant.id },
    orderBy: { seq: "asc" },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "AUDIT_EXPORTED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Tenant",
    subjectId: ctx.tenant.id,
    payload: {
      count: events.length,
      verified: { ok: verified.ok, failedAt: verified.failedAt?.toString() ?? null },
    },
  });

  const ndjson =
    events
      .map((e) => JSON.stringify({ ...e, seq: e.seq.toString() }))
      .join("\n") + "\n";

  return new NextResponse(ndjson, {
    headers: {
      "content-type": "application/x-ndjson",
      "x-audit-verified": verified.ok ? "ok" : `failed-at:${verified.failedAt}`,
      "content-disposition": `attachment; filename="audit-${slug}-${Date.now()}.ndjson"`,
    },
  });
}
