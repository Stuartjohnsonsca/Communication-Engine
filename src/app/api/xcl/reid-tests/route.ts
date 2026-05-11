import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { isAcumonOperator, recordReidentificationTest } from "@/lib/xcl";
import { safeApiError } from "@/lib/observability";

const inputSchema = z.object({
  tenantSlug: z.string(),
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/),
  conductedAt: z.string(),
  conductedByName: z.string().min(1).max(200),
  externalReviewer: z.boolean().default(true),
  sampleSize: z.number().int().min(1).max(10_000),
  reidentifiedCount: z.number().int().min(0),
  summary: z.string().min(1).max(4_000),
  notes: z.string().max(4_000).nullable().optional(),
});

/**
 * POST /api/xcl/reid-tests — record a quarterly re-identification test
 * (PRD §11.3). Acumon-side; same dual gate as the curator endpoints.
 * Upserts by quarter — re-running for the same quarter overwrites and is
 * audited via the standard write.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "xcl:curate");
  if (!isAcumonOperator(ctx.tenant.slug)) {
    return NextResponse.json({ error: "re-identification logs are Acumon-side only" }, { status: 403 });
  }

  const conductedAt = new Date(parsed.data.conductedAt);
  if (Number.isNaN(conductedAt.getTime())) {
    return NextResponse.json({ error: "invalid conductedAt" }, { status: 400 });
  }

  try {
    const test = await recordReidentificationTest({
      quarter: parsed.data.quarter,
      conductedAt,
      conductedByName: parsed.data.conductedByName,
      externalReviewer: parsed.data.externalReviewer,
      sampleSize: parsed.data.sampleSize,
      reidentifiedCount: parsed.data.reidentifiedCount,
      summary: parsed.data.summary,
      notes: parsed.data.notes ?? null,
      actorTenantId: ctx.tenant.id,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({ test });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/xcl/reid-tests" } });
  }
}
