import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { ingestTranscript } from "@/lib/meetings/minutes";

const inputSchema = z.object({
  tenantSlug: z.string(),
  source: z.enum(["TEAMS", "ZOOM", "MEET", "MANUAL"]),
  body: z.string().min(1).max(1_000_000),
});

/**
 * POST /api/meetings/:id/transcript — ingest (or replace) the meeting
 * transcript (PRD §7.5). Refused if note-taking is blocked because a
 * participant opted out.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "meeting:write");

  try {
    const updated = await ingestTranscript({
      tenantId: ctx.tenant.id,
      meetingId: id,
      source: parsed.data.source,
      body: parsed.data.body,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({ meeting: updated });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}
