import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { requirePermission } from "@/lib/rbac";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { rateLimitByMembership, tooManyRequestsResponse } from "@/lib/ratelimit";
import { safeApiError } from "@/lib/observability";

/**
 * Post-PRD hardening item 62 — operator unquarantine of inbound
 * messages that hit `QUARANTINE_THRESHOLD` consecutive failed draft
 * attempts.
 *
 * Clears `quarantinedFromDraftAt` + `quarantineReason` AND resets
 * `draftAttemptCount` to 0, so the retry gets a fresh budget. The
 * next cron tick picks the row back up via the standard candidate
 * query.
 *
 * Idempotent: unquarantining a non-quarantined message is a no-op
 * with `count: 0`. The audit event only fires when at least one row
 * actually transitioned.
 *
 * RBAC: `auto-draft:unquarantine` (FIRM_ADMIN only). Same posture as
 * `auto-draft:pause` — flipping it carelessly could re-thrash the
 * circuit breaker, so FCT gets read-only visibility on /admin/channels
 * but cannot retry.
 *
 * Rate-limited 12/hour/Member — generous for a button that operates
 * on a batch, defensive against a stuck JS in a tab.
 */
const inputSchema = z.object({
  tenantSlug: z.string().min(1),
  /// Accept either a list of explicit IDs or the literal `"all"` to
  /// unquarantine every quarantined inbound for this tenant. The
  /// "all" path is the common operator case after fixing a systemic
  /// issue (model update, prompt rewrite); the explicit-ids path is
  /// for "this one is genuinely unprocessable, leave it alone."
  ingestedMessageIds: z.union([
    z.literal("all"),
    z.array(z.string().min(1)).min(1).max(500),
  ]),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { tenantSlug, ingestedMessageIds } = parsed.data;
    const ctx = await getTenantContext(tenantSlug);
    if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    requirePermission(ctx.membership.role, "auto-draft:unquarantine");

    const rl = await rateLimitByMembership(
      ctx.membership.id,
      ctx.tenant.id,
      "auto-draft-unquarantine",
      12,
      60 * 60,
    );
    if (!rl.allowed) return tooManyRequestsResponse(rl);

    // Scope to this tenant — IDs supplied by the client are
    // attacker-controlled in principle; the where-clause is the
    // tenant-isolation gate.
    const where =
      ingestedMessageIds === "all"
        ? {
            tenantId: ctx.tenant.id,
            quarantinedFromDraftAt: { not: null },
          }
        : {
            tenantId: ctx.tenant.id,
            id: { in: ingestedMessageIds },
            quarantinedFromDraftAt: { not: null },
          };

    const targets = await superDb.ingestedMessage.findMany({
      where,
      select: { id: true },
    });
    if (targets.length === 0) {
      return NextResponse.json({ ok: true, count: 0 });
    }

    const targetIds = targets.map((t) => t.id);
    await superDb.ingestedMessage.updateMany({
      where: { id: { in: targetIds }, tenantId: ctx.tenant.id },
      data: {
        quarantinedFromDraftAt: null,
        quarantineReason: null,
        // Reset the counter so the retry gets a full budget — without
        // this, the next failure would immediately re-quarantine (count
        // was at threshold, increment to threshold+1, threshold met).
        draftAttemptCount: 0,
        lastDraftAttemptAt: null,
      },
    });

    await writeAuditEvent({
      tenantId: ctx.tenant.id,
      eventType: "INBOUND_DRAFT_UNQUARANTINED",
      actorMembershipId: ctx.membership.id,
      subjectType: "Tenant",
      subjectId: ctx.tenant.id,
      payload: {
        ingestedMessageIds: targetIds,
        count: targetIds.length,
      },
    });

    return NextResponse.json({ ok: true, count: targetIds.length });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/admin/auto-draft-unquarantine" } });
  }
}
