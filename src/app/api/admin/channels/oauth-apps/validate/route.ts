import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { validateTenantOAuthApp } from "@/lib/channels/validate-oauth";
import { safeApiError } from "@/lib/observability";
import { ForbiddenError, ValidationError } from "@/lib/api-errors";

/**
 * Item 109 — pre-flight validation for /admin/channels/oauth-apps.
 * POST { tenantSlug, channelKind } → runs format + (where cheap)
 * live checks against the configured ChannelOAuthApp row. Returns
 * `{ok, errors[], warnings[]}` so the UI can show a clear
 * green/red/yellow result inline before the operator hands the
 * link to staff.
 *
 * Same RBAC gate as the page handler:
 * `tenant:configure-channel-oauth-app` (FIRM_ADMIN).
 */

const inputSchema = z.object({
  tenantSlug: z.string(),
  channelKind: z.string(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("invalid request body", "invalid_body");
    }
    const ctx = await getTenantContext(parsed.data.tenantSlug);
    if (!ctx) throw new ForbiddenError("no tenant context");
    if (!hasPermission(ctx.membership.role, "tenant:configure-channel-oauth-app")) {
      throw new ForbiddenError("missing tenant:configure-channel-oauth-app");
    }
    const outcome = await validateTenantOAuthApp({
      tenantId: ctx.tenant.id,
      channelKind: parsed.data.channelKind,
    });
    return NextResponse.json(outcome);
  } catch (err) {
    return safeApiError(err, { ctx: { route: "api/admin/channels/oauth-apps/validate" } });
  }
}
