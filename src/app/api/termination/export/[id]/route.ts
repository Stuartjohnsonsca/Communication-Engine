import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";

/**
 * GET /api/termination/export/:id?tenantSlug=… — download a previously
 * generated export package as a JSON file. Caller must be the FIRM_ADMIN of
 * the tenant the export was generated for. The downloaded file uses the
 * `acumon.termination-export@1` schema documented in the package `meta`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const tenantSlug = url.searchParams.get("tenantSlug") ?? "";
  if (!tenantSlug) return NextResponse.json({ error: "tenantSlug required" }, { status: 400 });

  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "termination:read");

  const exportRow = await superDb.tenantTerminationExport.findFirst({
    where: { id, tenantId: ctx.tenant.id },
  });
  if (!exportRow) return NextResponse.json({ error: "not found" }, { status: 404 });

  const filename = `acumon-export-${ctx.tenant.slug}-${exportRow.generatedAt
    .toISOString()
    .slice(0, 10)}.json`;

  return new NextResponse(JSON.stringify(exportRow.payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
