import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { reopenBillingPeriod } from "@/lib/billing";

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
  const body = await req.json().catch(() => ({}));
  const reason = String((body as { reason?: unknown }).reason ?? "").trim();
  if (!reason) return NextResponse.json({ error: "reason required" }, { status: 400 });

  try {
    const result = await reopenBillingPeriod({
      tenantId: tctx.tenant.id,
      period,
      actorMembershipId: tctx.membership.id,
      reason,
    });
    return NextResponse.json({ ok: true, alreadyOpen: result.alreadyOpen });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "reopen failed" },
      { status: 400 },
    );
  }
}
