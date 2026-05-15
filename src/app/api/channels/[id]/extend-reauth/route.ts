import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { extendReauthDeadline } from "@/lib/channels/password-creds";
import { safeApiError } from "@/lib/observability";
import { ForbiddenError, ValidationError } from "@/lib/api-errors";

/**
 * Item 110 — User extends their personal `nextReauthAt`. Cannot
 * REDUCE; cannot dip below tenant floor — both invariants enforced
 * in `extendReauthDeadline`. This route is staff-self-service only;
 * a FIRM_ADMIN cannot extend OTHER staff's deadlines (force-revoke
 * via /api/channels/[id]/disconnect is the operator escape hatch).
 *
 * POST /api/channels/[id]/extend-reauth
 * Body: { tenantSlug, authId, requestedNextReauthAt: ISO date }
 * RBAC: `channels:connect-own` AND auth.membershipId === caller.
 */

const inputSchema = z.object({
  tenantSlug: z.string(),
  authId: z.string(),
  requestedNextReauthAt: z.string().datetime({ message: "ISO datetime required" }),
});

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.flatten().formErrors.join("; ") || "invalid request body",
        "invalid_body",
      );
    }
    const ctx = await getTenantContext(parsed.data.tenantSlug);
    if (!ctx) throw new ForbiddenError("no tenant context");
    if (!hasPermission(ctx.membership.role, "channels:connect-own")) {
      throw new ForbiddenError("missing channels:connect-own");
    }
    const { nextReauthAt, deltaDays } = await extendReauthDeadline({
      authId: parsed.data.authId,
      requestedNextReauthAt: new Date(parsed.data.requestedNextReauthAt),
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({
      ok: true,
      nextReauthAt: nextReauthAt.toISOString(),
      deltaDays,
    });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/channels/extend-reauth" } });
  }
}
