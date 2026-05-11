import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { isAcumonOperator, reviewCandidate } from "@/lib/xcl";
import { safeApiError } from "@/lib/observability";

const inputSchema = z.object({
  tenantSlug: z.string(),
  decision: z.enum(["APPROVE", "REJECT", "COMMIT"]),
  notes: z.string().max(2_000).nullable().optional(),
});

/**
 * PUT /api/xcl/candidates/:id — curator action (PRD §11.3 / §11.4).
 *
 * Two gates layered on top of the standard role check:
 *   1. xcl:curate (CURATOR / ACUMON_ADMIN / FIRM_ADMIN);
 *   2. The acting tenant must be the Acumon-internal tenant — the curator
 *      queue is Acumon-side per PRD §11.2 (independent controller).
 *
 * Audit event is written against the curator's (Acumon) tenant chain.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "xcl:curate");
  if (!isAcumonOperator(ctx.tenant.slug)) {
    return NextResponse.json({ error: "curator actions are Acumon-side only" }, { status: 403 });
  }

  try {
    const candidate = await reviewCandidate({
      candidateId: id,
      decision: parsed.data.decision,
      notes: parsed.data.notes ?? null,
      curatorTenantId: ctx.tenant.id,
      curatorMembershipId: ctx.membership.id,
      curatorName: ctx.user.name ?? ctx.user.email,
    });
    return NextResponse.json({ candidate });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/xcl/candidates/[id]" } });
  }
}
