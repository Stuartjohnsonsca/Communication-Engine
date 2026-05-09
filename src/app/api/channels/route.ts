import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { meta } from "@/lib/channels/registry";

const inputSchema = z.object({
  tenantSlug: z.string(),
  kind: z.string(),
  scope: z.unknown().optional(),
});

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "channels:write");

  // Validate the kind exists in the registry.
  try {
    meta(parsed.data.kind);
  } catch {
    return NextResponse.json({ error: "unknown channel kind" }, { status: 400 });
  }

  const channel = await superDb.channel.create({
    data: {
      tenantId: ctx.tenant.id,
      kind: parsed.data.kind,
      scope: (parsed.data.scope ?? null) as never,
      status: "INACTIVE",
    },
  });
  return NextResponse.json(channel);
}
