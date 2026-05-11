import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { generateExportPackage } from "@/lib/termination";
import { safeApiError } from "@/lib/observability";

const inputSchema = z.object({ tenantSlug: z.string() });

/**
 * POST /api/termination/export — build the §14.4 export bundle for the
 * caller's tenant. The package is stored on `TenantTerminationExport` and
 * `Tenant.terminationExportPackageId` is updated to point at the latest.
 *
 * Available before notice (PRD §15.3 "exportable on demand at no charge
 * during the contract") AND during wind-down. Refused once hard-deletion
 * has completed.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "termination:manage");

  try {
    const exportRow = await generateExportPackage({
      tenantId: ctx.tenant.id,
      generatedByMembershipId: ctx.membership.id,
      generatedByName: ctx.user.name ?? ctx.user.email,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({
      export: {
        id: exportRow.id,
        generatedAt: exportRow.generatedAt,
        generatedByName: exportRow.generatedByName,
        bytes: exportRow.bytes,
        counts: exportRow.counts,
      },
    });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/termination/export" } });
  }
}
