import { NextResponse } from "next/server";
import { superDb } from "@/lib/db";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { reportError } from "@/lib/observability";

/**
 * Liveness/readiness probe. Public, scrapable by external uptime
 * monitors (Railway, Better Uptime, etc.) and by internal LBs.
 *
 * Posture (post-PRD hardening):
 *   - Does NOT leak version, service name, or any build identifier.
 *     Reconnaissance value > zero; operator value zero.
 *   - Does NOT leak the underlying error message on failure. A Prisma
 *     "connection terminated unexpectedly" or "relation does not
 *     exist" reveals stack internals to anyone with curl. We log via
 *     `reportError` for operator visibility and surface a generic
 *     `{status:"error"}` to the client.
 *   - `Cache-Control: no-store` so an upstream proxy never caches a
 *     stale "ok" past a real outage.
 */
export async function GET(req: Request) {
  // Public, scrapable. Cap per-IP so a single source can't pin the DB
  // ping on this surface.
  const rl = await rateLimitByIp(req, "health", 60, 60);
  if (!rl.allowed) return tooManyRequestsResponse(rl);

  try {
    await superDb.$queryRaw`SELECT 1`;
    return NextResponse.json(
      { status: "ok" },
      {
        status: 200,
        headers: { "cache-control": "no-store, no-cache, must-revalidate" },
      },
    );
  } catch (err) {
    reportError(err, { route: "api/health" }, "health check DB ping failed");
    return NextResponse.json(
      { status: "error" },
      {
        status: 500,
        headers: { "cache-control": "no-store, no-cache, must-revalidate" },
      },
    );
  }
}
