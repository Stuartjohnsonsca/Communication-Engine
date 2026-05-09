import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { addCohortMember } from "@/lib/sandbox";

const inputSchema = z.object({
  tenantSlug: z.string(),
  sandboxTenantId: z.string().min(1),
  email: z.string().email().max(200),
  role: z.enum(["USER", "FCT_MEMBER", "FIRM_ADMIN"]).optional(),
});

/**
 * POST /api/sandbox/cohort — add a user to the sandbox cohort (PRD §14.2).
 * Caller must be FIRM_ADMIN of the parent tenant. Refused if the cohort is
 * full or the sandbox window has elapsed.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "sandbox:manage");

  try {
    const membership = await addCohortMember({
      sandboxTenantId: parsed.data.sandboxTenantId,
      parentTenantId: ctx.tenant.id,
      email: parsed.data.email,
      role: parsed.data.role,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({ membership });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}
