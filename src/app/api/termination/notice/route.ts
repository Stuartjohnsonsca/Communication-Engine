import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { noticeTermination } from "@/lib/termination";

const inputSchema = z.object({
  tenantSlug: z.string(),
  byName: z.string().min(1).max(200),
  reason: z.string().max(4_000).nullable().optional(),
  windowDays: z.number().int().min(1).max(365).optional(),
});

/**
 * POST /api/termination/notice — record termination notice (PRD §14.4).
 * Tenant moves ACTIVE → TERMINATING. Default window is 90 days; the
 * Client may negotiate a longer one (capped at 365). Reversible until
 * the hard-deletion sweep runs.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "termination:manage");

  try {
    const tenant = await noticeTermination({
      tenantId: ctx.tenant.id,
      byName: parsed.data.byName,
      reason: parsed.data.reason ?? null,
      windowDays: parsed.data.windowDays,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({ tenant });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}
