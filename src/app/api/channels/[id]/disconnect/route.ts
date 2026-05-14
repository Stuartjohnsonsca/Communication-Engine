import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { revokeChannelAuth } from "@/lib/channels/auths";
import { safeApiError } from "@/lib/observability";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/api-errors";

/**
 * Post-PRD hardening item 104 — disconnect a per-Membership ChannelAuth.
 *
 * Two paths:
 *   - Self-revoke: caller's Membership === auth.membershipId. Caller
 *     must have `channels:connect-own`. Used by /account UI.
 *   - Admin force-revoke: caller has `channels:write` (FIRM_ADMIN).
 *     The body's `membershipId` (the auth owner) can be any
 *     Membership in the tenant. Used by /admin/channels for
 *     terminated staff / compromised accounts.
 *
 * The audit row's `actorMembershipId` is the caller; the payload's
 * `membershipId` is the auth owner; `byActor` is `"self"` or
 * `"admin"`. Self-revoking your own auth records `byActor: "self"`
 * even if the caller happens to be a FIRM_ADMIN — the audit reflects
 * the operational fact (you revoked your own connection), not the
 * caller's role.
 *
 * Idempotent: revoking an already-revoked auth returns ok with no
 * audit. The Channel itself is untouched (status remains ACTIVE);
 * the channel-level INACTIVE flip is operator-driven via
 * /admin/channels.
 */

const inputSchema = z.object({
  tenantSlug: z.string(),
  /// The auth row to revoke. Discovered from /account or
  /// /admin/channels rosters.
  authId: z.string(),
  /// Optional human-friendly reason (chain reader sees it). Capped
  /// at 500 chars; longer is truncated.
  reason: z.string().max(500).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: urlChannelId } = await params;
    const body = await req.json().catch(() => ({}));
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.flatten().formErrors.join("; ") || "invalid request",
        "invalid_body",
      );
    }

    const ctx = await getTenantContext(parsed.data.tenantSlug);
    if (!ctx) throw new ForbiddenError("no tenant context");

    const auth = await superDb.channelAuth.findUnique({
      where: { id: parsed.data.authId },
      select: {
        id: true,
        tenantId: true,
        channelId: true,
        membershipId: true,
        revokedAt: true,
      },
    });
    if (!auth) throw new NotFoundError("auth not found");
    if (auth.tenantId !== ctx.tenant.id) {
      // Cross-tenant attempt — surface as not-found to avoid leaking
      // existence of foreign auths.
      throw new NotFoundError("auth not found");
    }
    // Defensive: verify the URL's channelId matches the auth's
    // channelId. Prevents a stale UI from trying to revoke an auth
    // through the wrong channel's URL (the body's authId is the
    // load-bearing identifier; URL is for routing + audit
    // correlation).
    if (auth.channelId !== urlChannelId) {
      throw new NotFoundError("auth not found");
    }

    const isSelf =
      auth.membershipId !== null && auth.membershipId === ctx.membership.id;
    const canForce = hasPermission(ctx.membership.role, "channels:write");
    const canSelf = hasPermission(ctx.membership.role, "channels:connect-own");

    if (!isSelf && !canForce) {
      // Trying to revoke someone else's auth, but not a FIRM_ADMIN.
      throw new ForbiddenError("missing channels:write");
    }
    if (isSelf && !canSelf && !canForce) {
      // Even self-revoke needs at least one of the perms.
      throw new ForbiddenError("missing channels:connect-own");
    }

    const r = await revokeChannelAuth({
      authId: auth.id,
      byActor: isSelf ? "self" : "admin",
      actorMembershipId: ctx.membership.id,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ ok: true, revoked: r.revoked });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/channels/disconnect" } });
  }
}
