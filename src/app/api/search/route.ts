import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { runSearch } from "@/lib/search";
import { reportError } from "@/lib/observability";
import { rateLimitByMembership, tooManyRequestsResponse } from "@/lib/ratelimit";

/**
 * Backlog item 8 — global ⌘K palette backend. Returns up to 40 hits across
 * Drafts, Actions, Meetings, Opportunities, Members, Audit Events,
 * FCG/UCG rules, Sub-processors, Processing activities, scoped to the
 * caller's tenant + role. Tenant isolation is enforced inside each source
 * (RLS for tenant-scoped models; superDb for global models).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const tenantSlug = url.searchParams.get("tenant") ?? "";
  if (!tenantSlug) {
    return NextResponse.json({ error: "tenant required" }, { status: 400 });
  }
  const ctx = await getTenantContext(tenantSlug);
  if (!ctx) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  // Search fans out to 10 concurrent DB queries — cap per-Membership QPS
  // so a stuck client (or a runaway debounce) can't pin a tenant's slot.
  const rl = await rateLimitByMembership(
    ctx.membership.id, ctx.tenant.id, "search", 60, 60,
  );
  if (!rl.allowed) return tooManyRequestsResponse(rl);

  try {
    const result = await runSearch({
      q,
      tenant: ctx.tenant,
      membership: ctx.membership,
    });
    return NextResponse.json(result);
  } catch (e) {
    reportError(e, {
      route: "api/search",
      tenantId: ctx.tenant.id,
      tenantSlug,
      extra: { q },
    }, "search failed");
    return NextResponse.json({ error: "search failed" }, { status: 500 });
  }
}
