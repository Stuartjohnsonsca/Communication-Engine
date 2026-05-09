import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { provisionSandbox } from "@/lib/sandbox";

const inputSchema = z.object({
  tenantSlug: z.string(),
  durationDays: z.number().int().min(1).max(180).optional(),
  cohortLimit: z.number().int().min(1).max(50).optional(),
});

/**
 * POST /api/sandbox/provision — open a Sandbox alongside the caller's tenant
 * (PRD §14.2). The caller's tenant must NOT itself be a sandbox.
 * Refused if an open sandbox already exists for the parent.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "sandbox:manage");
  if (ctx.tenant.isSandbox) {
    return NextResponse.json({ error: "cannot provision a sandbox of a sandbox" }, { status: 400 });
  }

  try {
    const sandbox = await provisionSandbox({
      parentTenantId: ctx.tenant.id,
      actorMembershipId: ctx.membership.id,
      durationDays: parsed.data.durationDays,
      cohortLimit: parsed.data.cohortLimit,
    });
    return NextResponse.json({ sandbox });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}
