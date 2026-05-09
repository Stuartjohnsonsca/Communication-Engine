import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { initiateScan, listScans } from "@/lib/culture-scan";
import type { ChannelKind } from "@/lib/channels/registry";

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "missing tenant" }, { status: 400 });
  const ctx = await getTenantContext(slug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "fcg:scan:read");
  return NextResponse.json(await listScans(ctx.tenant.id));
}

export async function POST(req: Request) {
  const slug = new URL(req.url).searchParams.get("tenant");
  if (!slug) return NextResponse.json({ error: "missing tenant" }, { status: 400 });
  const ctx = await getTenantContext(slug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "fcg:scan:run");

  const body = (await req.json()) as {
    dateRangeFrom?: string;
    dateRangeTo?: string;
    channelKinds?: ChannelKind[];
  };
  if (!body.dateRangeFrom || !body.dateRangeTo) {
    return NextResponse.json({ error: "dateRangeFrom and dateRangeTo required" }, { status: 400 });
  }
  try {
    const scan = await initiateScan({
      tenantId: ctx.tenant.id,
      initiatedById: ctx.membership.id,
      dateRangeFrom: new Date(body.dateRangeFrom),
      dateRangeTo: new Date(body.dateRangeTo),
      channelKinds: body.channelKinds ?? [],
    });
    return NextResponse.json(scan);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "scan failed" },
      { status: 400 },
    );
  }
}
