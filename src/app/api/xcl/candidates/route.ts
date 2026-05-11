import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { proposeCandidate } from "@/lib/xcl";
import { safeApiError } from "@/lib/observability";

const inputSchema = z.object({
  tenantSlug: z.string(),
  kind: z.enum(["FCG_AMENDMENT", "OPPORTUNITY_RULE", "JUDGE_PROMPT"]),
  sourceSubjectType: z.string().min(1).max(64),
  sourceSubjectId: z.string().min(1).max(64),
  originalText: z.string().min(1).max(8_000),
});

/**
 * POST /api/xcl/candidates — propose an insight from the caller's tenant
 * into the XCL pipeline (PRD §11.3). The tenant must be opted in or the
 * helper rejects. The auto-redaction pipeline runs synchronously; the
 * curator queue is global (Acumon side).
 *
 * In the auto-flow, FCG amendments / opportunity reviewer decisions would
 * call `proposeCandidate` directly from their own modules. This endpoint
 * is the manual entry point — useful for the curator console seeding and
 * for v1 testing.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Source-tenant operators flag the insight (the curator pipeline does the
  // review). xcl:read covers FIRM_ADMIN + FCT_MEMBER + CURATOR + ACUMON_ADMIN.
  requirePermission(ctx.membership.role, "xcl:read");

  try {
    const candidate = await proposeCandidate({
      sourceTenantId: ctx.tenant.id,
      sourceSubjectType: parsed.data.sourceSubjectType,
      sourceSubjectId: parsed.data.sourceSubjectId,
      kind: parsed.data.kind,
      originalText: parsed.data.originalText,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({ candidate });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/xcl/candidates" } });
  }
}
