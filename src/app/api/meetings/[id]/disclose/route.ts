import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { discloseNoteTaking } from "@/lib/meetings/minutes";

const inputSchema = z.object({ tenantSlug: z.string() });

/**
 * POST /api/meetings/:id/disclose — record that the AI-assisted note-taking
 * disclosure was sent to participants (PRD §7.5). Idempotent: re-calling on
 * an already-disclosed meeting returns the existing timestamp without
 * writing another audit event.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "meeting:write");

  const meeting = await superDb.meeting.findFirst({
    where: { id, tenantId: ctx.tenant.id },
  });
  if (!meeting) return NextResponse.json({ error: "not found" }, { status: 404 });

  const updated = await discloseNoteTaking({
    tenantId: ctx.tenant.id,
    meetingId: meeting.id,
    actorMembershipId: ctx.membership.id,
  });
  return NextResponse.json({ meeting: updated });
}
