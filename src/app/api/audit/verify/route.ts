import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { verifyAuditChain } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";

const inputSchema = z.object({ tenantSlug: z.string() });

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "audit:read");

  const startedAt = Date.now();
  const result = await verifyAuditChain(ctx.tenant.id);
  const latest = await superDb.auditEvent.findFirst({
    where: { tenantId: ctx.tenant.id },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const eventCount = latest ? Number(latest.seq) : 0;
  const tookMs = Date.now() - startedAt;

  return NextResponse.json({
    ok: result.ok,
    failedAt: result.failedAt ? Number(result.failedAt) : null,
    eventCount,
    latestSeq: latest ? Number(latest.seq) : null,
    tookMs,
    verifiedAt: new Date().toISOString(),
  });
}
