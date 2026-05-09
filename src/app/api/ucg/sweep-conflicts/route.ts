import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { sweepConflictedUcgs } from "@/lib/ucg/propagation";

/**
 * Auto-suspend conflicting UCG rules whose grace period has elapsed.
 *
 * Two callers per PRD §5.2.2:
 *  • A FIRM_ADMIN running a manual sweep for one tenant.
 *  • The platform cron, which sets `Authorization: Bearer ${CRON_SECRET}`
 *    and either passes a tenant slug or sweeps every active tenant.
 */
const inputSchema = z.object({
  tenantSlug: z.string().optional(),
  allTenants: z.boolean().optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const cronSecret = process.env.CRON_SECRET;
  const authz = req.headers.get("authorization") ?? "";
  const isCron = !!cronSecret && authz === `Bearer ${cronSecret}`;

  if (parsed.data.allTenants) {
    if (!isCron) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const tenants = await superDb.tenant.findMany({
      where: { status: { in: ["ACTIVE", "SANDBOX"] } },
      select: { id: true, slug: true },
    });
    const results = [] as { tenantSlug: string; ucgsSwept: number; rulesSuspended: number }[];
    for (const t of tenants) {
      const r = await sweepConflictedUcgs({ tenantId: t.id });
      results.push({ tenantSlug: t.slug, ...r });
    }
    return NextResponse.json({ tenants: results });
  }

  if (!parsed.data.tenantSlug) {
    return NextResponse.json({ error: "tenantSlug or allTenants required" }, { status: 400 });
  }

  if (isCron) {
    const tenant = await superDb.tenant.findUnique({
      where: { slug: parsed.data.tenantSlug },
      select: { id: true },
    });
    if (!tenant) return NextResponse.json({ error: "tenant not found" }, { status: 404 });
    const result = await sweepConflictedUcgs({ tenantId: tenant.id });
    return NextResponse.json(result);
  }

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Sweeping mutates membership-visible state; reuse the members:write
  // permission so the existing FIRM_ADMIN-only matrix still gates it.
  requirePermission(ctx.membership.role, "members:write");
  const result = await sweepConflictedUcgs({ tenantId: ctx.tenant.id });
  return NextResponse.json(result);
}
