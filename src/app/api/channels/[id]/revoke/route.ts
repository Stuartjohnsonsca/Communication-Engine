import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { writeAuditEvent } from "@/lib/audit";

const inputSchema = z.object({ tenantSlug: z.string() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "channels:write");

  const channel = await superDb.channel.findFirst({
    where: { id, tenantId: ctx.tenant.id },
  });
  if (!channel) return NextResponse.json({ error: "not found" }, { status: 404 });

  await superDb.channelAuth.updateMany({
    where: { channelId: channel.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await superDb.channel.update({ where: { id: channel.id }, data: { status: "REVOKED" } });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "CHANNEL_REVOKED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Channel",
    subjectId: channel.id,
    payload: { kind: channel.kind },
  });
  return NextResponse.json({ ok: true });
}
