import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { setPasswordCreds } from "@/lib/channels/password-creds";
import { safeApiError } from "@/lib/observability";
import { ForbiddenError, ValidationError } from "@/lib/api-errors";

/**
 * Item 110 — staff-self-service IMAP password connect.
 *
 * POST /api/channels/[id]/connect-imap
 * Body: { tenantSlug, username, password }
 * RBAC: `channels:connect-own` (every Membership except SALES_REVIEWER).
 * Returns: { ok, nextReauthAt }
 *
 * Re-entry on a previously-connected channel soft-revokes the prior
 * row + creates a fresh one. The plaintext password is encrypted at
 * rest via `encryptJson` inside `setPasswordCreds`; no logging,
 * no echo back in the response.
 */

const inputSchema = z.object({
  tenantSlug: z.string(),
  username: z.string().min(1, "username required"),
  password: z.string().min(1, "password required"),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: channelId } = await params;
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
    const { authId, nextReauthAt, isFreshConnect } = await setPasswordCreds({
      tenantId: ctx.tenant.id,
      channelId,
      membershipId: ctx.membership.id,
      username: parsed.data.username,
      password: parsed.data.password,
      actorMembershipId: ctx.membership.id,
    });
    return NextResponse.json({
      ok: true,
      authId,
      nextReauthAt: nextReauthAt.toISOString(),
      isFreshConnect,
    });
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/channels/connect-imap" } });
  }
}
