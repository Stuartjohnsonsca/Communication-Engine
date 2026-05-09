import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { runScan, getScan } from "@/lib/culture-scan";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const slug = new URL(req.url).searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "missing tenant" }, { status: 400 });
  const ctx = await getTenantContext(slug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "fcg:scan:run");

  const existing = await getScan(id, ctx.tenant.id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    const scan = await runScan(id);
    return NextResponse.json(scan);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "run failed" },
      { status: 400 },
    );
  }
}
