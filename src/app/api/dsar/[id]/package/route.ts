import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { extractCounterpartyPackage, extractUserPackage } from "@/lib/dsar/extract";

/**
 * Stream the DSAR extraction package as pretty JSON. Per PRD §12.4 the
 * format is "machine-readable (JSON + CSV) and human-readable (PDF) where
 * applicable" — JSON covers the core obligation; CSV/PDF emitters can wrap
 * the same package object later.
 *
 * The download itself is not an act of fulfilment — it's the tooling that
 * lets the Firm Administrator review the package before signing it off via
 * the "Mark fulfilled" action on the DSAR row. We therefore do *not* write
 * a DSAR_FULFILLED audit event here.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "missing tenant" }, { status: 400 });

  const tctx = await getTenantContext(slug);
  if (!tctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(tctx.membership.role, "dsar:read");

  const { id } = await ctx.params;
  const dsar = await superDb.dSARequest.findFirst({
    where: { id, tenantId: tctx.tenant.id },
  });
  if (!dsar) return NextResponse.json({ error: "not found" }, { status: 404 });

  const pkg =
    dsar.subjectType === "USER"
      ? await extractUserPackage({
          tenantId: tctx.tenant.id,
          tenantSlug: slug,
          email: dsar.subjectIdent,
        })
      : await extractCounterpartyPackage({
          tenantId: tctx.tenant.id,
          tenantSlug: slug,
          email: dsar.subjectIdent,
        });

  const enveloped = {
    dsar: {
      id: dsar.id,
      kind: dsar.kind,
      subjectType: dsar.subjectType,
      subjectIdent: dsar.subjectIdent,
      status: dsar.status,
      openedAt: dsar.openedAt.toISOString(),
      dueAt: dsar.dueAt?.toISOString() ?? null,
      fulfilledAt: dsar.fulfilledAt?.toISOString() ?? null,
      packageRef: dsar.packageRef ?? null,
    },
    package: pkg,
  };

  const body = JSON.stringify(enveloped, null, 2);
  const filename = `dsar-${dsar.kind.toLowerCase()}-${dsar.subjectType.toLowerCase()}-${dsar.id.slice(-6)}.json`;
  return new NextResponse(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
