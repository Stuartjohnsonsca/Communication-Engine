import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission, PermissionError } from "@/lib/rbac";
import { writeAuditEvent } from "@/lib/audit";
import { buildEvidencePack } from "@/lib/compliance/evidence-pack";

/**
 * POST /api/compliance/evidence-pack
 *
 * Body: `{ "tenantSlug": "<slug>" }`
 *
 * Session-authenticated download endpoint for the per-tenant compliance
 * evidence pack. Sits behind `compliance:export-evidence-pack` RBAC.
 * Writes a `COMPLIANCE_EVIDENCE_PACK_EXPORTED` audit event with the
 * actor + exported-section list before returning the JSON file.
 *
 * Response is `application/json` with `content-disposition: attachment`
 * so the browser downloads it directly. The body is the pack JSON.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const tenantSlug =
    body && typeof body === "object" && typeof (body as { tenantSlug?: unknown }).tenantSlug === "string"
      ? (body as { tenantSlug: string }).tenantSlug
      : null;
  if (!tenantSlug) {
    return NextResponse.json(
      { error: "tenantSlug is required" },
      { status: 400 },
    );
  }

  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    requirePermission(ctx.membership.role, "compliance:export-evidence-pack");
  } catch (err) {
    if (err instanceof PermissionError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const pack = await buildEvidencePack({ tenantId: ctx.tenant.id });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "COMPLIANCE_EVIDENCE_PACK_EXPORTED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Tenant",
    subjectId: ctx.tenant.id,
    payload: {
      exportedSections: pack.meta.sections,
      schemaVersion: pack.meta.schemaVersion,
      activeSubProcessors: pack.subProcessors.activeCount,
      pendingSubProcessorChanges: pack.subProcessors.pendingChanges.length,
      activeApiKeys: pack.apiKeys.activeCount,
      totalAuditEvents: pack.auditChain.totalEvents,
    },
  });

  const filename = `acumon-evidence-pack-${tenantSlug}-${pack.meta.generatedAt.slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(pack, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
