import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { discardScan } from "@/lib/culture-scan";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const slug = new URL(req.url).searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "missing tenant" }, { status: 400 });
  const ctx = await getTenantContext(slug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "fcg:scan:run");

  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  try {
    const scan = await discardScan({
      scanId: id,
      tenantId: ctx.tenant.id,
      actorMembershipId: ctx.membership.id,
      reason: body.reason,
    });
    return NextResponse.json(scan);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "discard failed" },
      { status: 400 },
    );
  }
}
