import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { tenantDb } from "@/lib/db";

/**
 * Mark every unread NotificationInbox row for the current membership as
 * read. Tenant-scoped via `tenantDb`; restricted to the User's own rows.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { tenantSlug?: string };
  if (!body.tenantSlug) {
    return NextResponse.json({ error: "tenantSlug required" }, { status: 400 });
  }
  const ctx = await getTenantContext(body.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const result = await tenantDb(ctx.tenant.id).notificationInbox.updateMany({
    where: {
      tenantId: ctx.tenant.id,
      membershipId: ctx.membership.id,
      readAt: null,
    },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true, marked: result.count });
}
