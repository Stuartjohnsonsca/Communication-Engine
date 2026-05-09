import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { getEstimate, snapshotsToCsv } from "@/lib/billing";

/**
 * CSV export of the per-User breakdown for a billing period (PRD §15.2 —
 * the reasoning behind each User's billable / non-billable determination).
 *
 * For closed periods we serve the snapshotted rows; for the in-progress
 * month we run a fresh estimate so the FA sees a live picture.
 */
export async function GET(req: Request, ctx: { params: Promise<{ period: string }> }) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "missing tenant" }, { status: 400 });

  const tctx = await getTenantContext(slug);
  if (!tctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    requirePermission(tctx.membership.role, "billing:read");
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { period } = await ctx.params;

  const closed = await superDb.billingPeriod.findUnique({
    where: { tenantId_period: { tenantId: tctx.tenant.id, period } },
    include: { snapshots: { orderBy: { userEmail: "asc" } } },
  });

  let csv: string;
  if (closed && closed.status === "CLOSED") {
    csv = snapshotsToCsv(
      closed.snapshots.map((s) => ({
        userEmail: s.userEmail,
        role: s.role,
        membershipStatus: s.membershipStatus,
        hasAuthorisedChannel: s.hasAuthorisedChannel,
        loggedInThisPeriod: s.loggedInThisPeriod,
        hadDraftThisPeriod: s.hadDraftThisPeriod,
        draftCount: s.draftCount,
        isActiveByPRD: s.isActiveByPRD,
        isBillable: s.isBillable,
        salesIdentifierApplies: s.salesIdentifierApplies,
        reason: s.reason,
      })),
    );
  } else {
    const est = await getEstimate({ tenantId: tctx.tenant.id, period });
    csv = snapshotsToCsv(
      est.rows.map((r) => ({
        userEmail: r.membership.user.email,
        role: r.membership.role,
        membershipStatus: r.membership.status,
        hasAuthorisedChannel: r.hasAuthorisedChannel,
        loggedInThisPeriod: r.loggedInThisPeriod,
        hadDraftThisPeriod: r.hadDraftThisPeriod,
        draftCount: r.draftCount,
        isActiveByPRD: r.isActiveByPRD,
        isBillable: r.isBillable,
        salesIdentifierApplies: r.salesIdentifierApplies,
        reason: r.reason,
      })),
    );
  }

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="billing-${slug}-${period}.csv"`,
    },
  });
}
