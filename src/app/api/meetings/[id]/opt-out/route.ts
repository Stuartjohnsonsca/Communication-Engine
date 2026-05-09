import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { recordOptOut } from "@/lib/meetings/minutes";

const inputSchema = z.object({
  tenantSlug: z.string(),
  participantId: z.string().min(1),
  reason: z.string().max(1_000).nullable().optional(),
});

/**
 * POST /api/meetings/:id/opt-out — record a participant's opt-out from
 * AI-assisted note-taking (PRD §7.5). Any opt-out blocks transcript
 * ingestion for the whole meeting.
 *
 * In production an external participant would land here via a per-participant
 * opt-out link from the disclosure email. For v1 the paper-author / Chair /
 * FCT records the opt-out on the participant's behalf when the participant
 * tells them out-of-band — same DB outcome, audited as "actor recorded the
 * opt-out".
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
    const result = await recordOptOut({
      tenantId: ctx.tenant.id,
      meetingId: id,
      participantId: parsed.data.participantId,
      reason: parsed.data.reason ?? null,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
  }
}
