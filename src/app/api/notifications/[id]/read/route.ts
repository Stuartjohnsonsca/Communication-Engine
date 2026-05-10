import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { tenantDb } from "@/lib/db";

/**
 * Mark a single inbox row as read. Tenant-scoped via `tenantDb` so RLS
 * enforces isolation in addition to the where clause; the membership check
 * additionally restricts to the User's own rows.
 *
 * Body: `{ tenantSlug }`. Idempotent — calling on an already-read row is a
 * no-op that returns 200.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { tenantSlug?: string };
  if (!body.tenantSlug) {
    return NextResponse.json({ error: "tenantSlug required" }, { status: 400 });
  }
  const ctx = await getTenantContext(body.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const db = tenantDb(ctx.tenant.id);
  const row = await db.notificationInbox.findFirst({
    where: { id, tenantId: ctx.tenant.id, membershipId: ctx.membership.id },
  });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (row.readAt) return NextResponse.json({ ok: true, alreadyRead: true });

  await db.notificationInbox.update({
    where: { id: row.id },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
