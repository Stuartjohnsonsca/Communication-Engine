import { NextResponse } from "next/server";
import { buildForRequest } from "@/lib/security-disclosure";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";

/**
 * RFC 9116 security.txt. Reached via `/.well-known/security.txt` (the
 * canonical path) which `next.config.ts` rewrites to this endpoint.
 *
 * Public, unauthenticated, text/plain. Rebuilt per-request so the
 * `Expires:` field stays under the 1-year ceiling without a CI cron
 * rotating a static asset. Per-IP rate-limit guards against an
 * accidental scrape loop hammering the route.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rl = await rateLimitByIp(req, "security-txt", 30, 60);
  if (!rl.allowed) return tooManyRequestsResponse(rl);
  const body = buildForRequest(new URL(req.url));
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // 1-hour CDN cache so a busy /status page-link doesn't generate a
      // build per click but the daily-ish refresh still re-stamps the
      // Expires field within the spec's ceiling.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
