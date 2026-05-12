import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { runAutoDraftBackfill, BACKFILL_DAYS_BOUNDS } from "@/lib/drafts";
import { rateLimitByMembership, tooManyRequestsResponse } from "@/lib/ratelimit";
import { safeApiError } from "@/lib/observability";

/**
 * Post-PRD hardening item 51 — operator-triggered backfill of the
 * auto-draft sweep onto historic ingested inbound.
 *
 * Default cadence is continuous (the `auto-draft` cron picks up new
 * mail within ~5 minutes). This route lets a Firm Administrator press
 * a button on /admin/channels and say "draft the last N days of
 * inbound" — useful when the platform is first connected to a
 * mailbox, or when a backlog has accumulated past the 24h cron
 * window for any reason.
 *
 * Bounded: `daysBack` clamped to [1, 365], per-tenant cap clamped to
 * 500 produced drafts per press. Re-press to continue past the cap;
 * `produceDraftFromInbound` is idempotent on `IngestedMessage.id`
 * so already-drafted rows are skipped.
 *
 * RBAC: `channels:write` (same gate as channel configuration).
 * Rate-limited per-Membership: 3 presses per hour, so a button
 * stuck on auto-click can't run away.
 */
const inputSchema = z.object({
  tenantSlug: z.string().min(1),
  daysBack: z.number().int().min(BACKFILL_DAYS_BOUNDS.min).max(BACKFILL_DAYS_BOUNDS.max),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { tenantSlug, daysBack } = parsed.data;
    const ctx = await getTenantContext(tenantSlug);
    if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    requirePermission(ctx.membership.role, "channels:write");

    const rl = await rateLimitByMembership(
      ctx.membership.id,
      ctx.tenant.id,
      "auto-draft-backfill",
      3,
      60 * 60,
    );
    if (!rl.allowed) return tooManyRequestsResponse(rl);

    const result = await runAutoDraftBackfill({
      tenantId: ctx.tenant.id,
      actorMembershipId: ctx.membership.id,
      daysBack,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/admin/auto-draft-backfill" } });
  }
}
