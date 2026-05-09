import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { closeBillingPeriod } from "@/lib/billing";

/**
 * Manual close of a billing period (PRD §15.1). FA-only. By default we
 * refuse to close a period whose end is in the future; the form posts
 * `?force=1` for the FA-cuts-a-partial-month-invoice case.
 */
export async function POST(req: Request, ctx: { params: Promise<{ period: string }> }) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "missing tenant" }, { status: 400 });

  const tctx = await getTenantContext(slug);
  if (!tctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    requirePermission(tctx.membership.role, "billing:manage");
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { period } = await ctx.params;
  const force = url.searchParams.get("force") === "1";

  try {
    const result = await closeBillingPeriod({
      tenantId: tctx.tenant.id,
      period,
      actorMembershipId: tctx.membership.id,
      allowFutureClose: force,
    });
    return NextResponse.json({
      ok: true,
      alreadyClosed: result.alreadyClosed,
      period: { id: result.period.id, period: result.period.period, totalMinor: result.period.totalMinor },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "close failed" },
      { status: 400 },
    );
  }
}
