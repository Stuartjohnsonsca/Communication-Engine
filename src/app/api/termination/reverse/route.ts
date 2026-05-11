import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { reverseTermination } from "@/lib/termination";
import { safeApiError } from "@/lib/observability";

const inputSchema = z.object({
  tenantSlug: z.string(),
  byName: z.string().min(1).max(200),
  notes: z.string().max(4_000).nullable().optional(),
});

/**
 * POST /api/termination/reverse — withdraw a termination notice (PRD §14.4).
 * Allowed any time before the cron-driven hard-deletion sweep runs. Tenant
 * returns to ACTIVE; previously-generated export packages remain on file.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "termination:manage");

  try {
    const tenant = await reverseTermination({
      tenantId: ctx.tenant.id,
      byName: parsed.data.byName,
      notes: parsed.data.notes ?? null,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({ tenant });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/termination/reverse" } });
  }
}
