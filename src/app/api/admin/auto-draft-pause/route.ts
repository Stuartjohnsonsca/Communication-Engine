import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { rateLimitByMembership, tooManyRequestsResponse } from "@/lib/ratelimit";
import { safeApiError } from "@/lib/observability";

/**
 * Post-PRD hardening item 58 — tenant-level auto-draft pause toggle.
 *
 * Operator circuit breaker for the auto-draft cron + backfill. Sets
 * `Tenant.autoDraftPausedAt` (non-null = paused; null = enabled).
 * Records `AUTO_DRAFT_PAUSED` / `AUTO_DRAFT_RESUMED` audit events
 * with the actor + optional reason. Idempotent: pausing an already-
 * paused tenant updates the reason without changing pausedAt.
 *
 * Does NOT affect /api/ai/draft (manual paste) — operator might want
 * to keep ad-hoc User work running while halting background production.
 * Per-Member lifecycle halt continues to apply independently.
 *
 * RBAC: `auto-draft:pause` (FIRM_ADMIN only). Operationally invasive
 * — pauses background drafting for every Member.
 * Rate-limited 6/hour/Member: tapping the toggle is fine, scripting
 * it is not.
 */
const inputSchema = z.object({
  tenantSlug: z.string().min(1),
  action: z.enum(["pause", "resume"]),
  reason: z.string().trim().max(500).optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { tenantSlug, action, reason } = parsed.data;
    const ctx = await getTenantContext(tenantSlug);
    if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    requirePermission(ctx.membership.role, "auto-draft:pause");

    const rl = await rateLimitByMembership(
      ctx.membership.id,
      ctx.tenant.id,
      "auto-draft-pause",
      6,
      60 * 60,
    );
    if (!rl.allowed) return tooManyRequestsResponse(rl);

    const actorName = ctx.user.name ?? ctx.user.email ?? ctx.membership.id;
    const tenant = await superDb.tenant.findUnique({
      where: { id: ctx.tenant.id },
      select: { autoDraftPausedAt: true },
    });
    if (!tenant) return NextResponse.json({ error: "not found" }, { status: 404 });

    if (action === "pause") {
      // Idempotent: if already paused, update the reason + actor but
      // keep the original pausedAt (the "since when" should reflect
      // the FIRST pause in the current paused window, not the latest
      // touch). The audit row still records this as a fresh
      // AUTO_DRAFT_PAUSED event so the trail captures the new reason.
      const now = new Date();
      const wasPausedAt = tenant.autoDraftPausedAt;
      await superDb.tenant.update({
        where: { id: ctx.tenant.id },
        data: {
          autoDraftPausedAt: wasPausedAt ?? now,
          autoDraftPausedByName: actorName,
          autoDraftPauseReason: reason ?? null,
        },
      });
      await writeAuditEvent({
        tenantId: ctx.tenant.id,
        eventType: "AUTO_DRAFT_PAUSED",
        actorMembershipId: ctx.membership.id,
        subjectType: "Tenant",
        subjectId: ctx.tenant.id,
        payload: {
          reason: reason ?? null,
          priorPausedAt: wasPausedAt?.toISOString() ?? null,
        },
      });
      return NextResponse.json({ ok: true, pausedAt: (wasPausedAt ?? now).toISOString() });
    }

    // action === "resume"
    if (!tenant.autoDraftPausedAt) {
      // Idempotent: resuming a non-paused tenant is a no-op + audit row.
      return NextResponse.json({ ok: true, pausedAt: null });
    }
    const pausedAt = tenant.autoDraftPausedAt;
    const pausedDurationMinutes = Math.round(
      (Date.now() - pausedAt.getTime()) / 60_000,
    );
    await superDb.tenant.update({
      where: { id: ctx.tenant.id },
      data: {
        autoDraftPausedAt: null,
        autoDraftPausedByName: null,
        autoDraftPauseReason: null,
      },
    });
    await writeAuditEvent({
      tenantId: ctx.tenant.id,
      eventType: "AUTO_DRAFT_RESUMED",
      actorMembershipId: ctx.membership.id,
      subjectType: "Tenant",
      subjectId: ctx.tenant.id,
      payload: {
        pausedAt: pausedAt.toISOString(),
        pausedDurationMinutes,
      },
    });
    return NextResponse.json({ ok: true, pausedAt: null, pausedDurationMinutes });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/admin/auto-draft-pause" } });
  }
}
