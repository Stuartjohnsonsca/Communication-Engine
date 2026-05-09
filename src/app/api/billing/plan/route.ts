import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { updateTenantPlan } from "@/lib/billing";

/**
 * Update the tenant's billing plan (PRD §15.1). FA-only. The body is a
 * partial of the editable plan fields — anything omitted is left untouched.
 * Every change is captured in `BILLING_PLAN_UPDATED` with a from/to diff.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "missing tenant" }, { status: 400 });

  const ctx = await getTenantContext(slug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    requirePermission(ctx.membership.role, "billing:manage");
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const updates = {
    pricingCurrency: maybeString(body.pricingCurrency),
    pricingBaseMinor: maybeInt(body.pricingBaseMinor),
    pricingSalesIdMinor: maybeInt(body.pricingSalesIdMinor),
    pricingSalesIdPartnerDefault: maybeBool(body.pricingSalesIdPartnerDefault),
    pricingSalesIdPartnerDiscountPct: maybeInt(body.pricingSalesIdPartnerDiscountPct),
    pricingCrossClientLearningOptIn: maybeBool(body.pricingCrossClientLearningOptIn),
    pricingCclDiscountPct: maybeInt(body.pricingCclDiscountPct),
    pricingCmkEnabled: maybeBool(body.pricingCmkEnabled),
    pricingCmkMinor: maybeInt(body.pricingCmkMinor),
  };

  const after = await updateTenantPlan({
    tenantId: ctx.tenant.id,
    actorMembershipId: ctx.membership.id,
    updates,
  });
  return NextResponse.json({ ok: true, plan: pickPlan(after) });
}

function maybeString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function maybeInt(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
function maybeBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}
function pickPlan(t: {
  pricingCurrency: string;
  pricingBaseMinor: number;
  pricingSalesIdMinor: number;
  pricingSalesIdPartnerDefault: boolean;
  pricingSalesIdPartnerDiscountPct: number;
  pricingCrossClientLearningOptIn: boolean;
  pricingCclDiscountPct: number;
  pricingCmkEnabled: boolean;
  pricingCmkMinor: number;
}) {
  return {
    pricingCurrency: t.pricingCurrency,
    pricingBaseMinor: t.pricingBaseMinor,
    pricingSalesIdMinor: t.pricingSalesIdMinor,
    pricingSalesIdPartnerDefault: t.pricingSalesIdPartnerDefault,
    pricingSalesIdPartnerDiscountPct: t.pricingSalesIdPartnerDiscountPct,
    pricingCrossClientLearningOptIn: t.pricingCrossClientLearningOptIn,
    pricingCclDiscountPct: t.pricingCclDiscountPct,
    pricingCmkEnabled: t.pricingCmkEnabled,
    pricingCmkMinor: t.pricingCmkMinor,
  };
}
