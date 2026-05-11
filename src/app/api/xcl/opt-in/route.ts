import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { setOptIn } from "@/lib/xcl";
import { safeApiError } from "@/lib/observability";

const inputSchema = z
  .object({
    tenantSlug: z.string(),
    optIn: z.boolean(),
    signedByName: z.string().max(200).nullable().optional(),
    addendumRef: z.string().max(200).nullable().optional(),
    reason: z.string().max(2_000).nullable().optional(),
  })
  .refine(
    (v) =>
      v.optIn
        ? !!(v.signedByName && v.signedByName.trim() && v.addendumRef && v.addendumRef.trim())
        : true,
    { message: "opt-in requires signedByName and addendumRef" },
  );

/**
 * POST /api/xcl/opt-in — flip the caller's tenant XCL opt-in (PRD §11.2).
 * Opting in requires the addendum signer's name and a reference to the
 * addendum document. Opting out captures an optional reason. Audit event
 * goes to the caller's tenant chain.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "xcl:opt-in");

  try {
    const tenant = await setOptIn({
      tenantId: ctx.tenant.id,
      optIn: parsed.data.optIn,
      signedByName: parsed.data.signedByName ?? null,
      addendumRef: parsed.data.addendumRef ?? null,
      reason: parsed.data.reason ?? null,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({
      tenant: {
        id: tenant.id,
        optedIn: tenant.pricingCrossClientLearningOptIn,
        optedInAt: tenant.crossClientLearningOptedInAt,
        optedInByName: tenant.crossClientLearningOptedInByName,
        addendumRef: tenant.crossClientLearningAddendumRef,
        optedOutAt: tenant.crossClientLearningOptedOutAt,
      },
    });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/xcl/opt-in" } });
  }
}
