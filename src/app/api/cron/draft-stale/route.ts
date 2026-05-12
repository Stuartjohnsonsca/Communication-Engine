import { NextResponse } from "next/server";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat, cronJson } from "@/lib/cron-health";
import { runDraftStaleSweep } from "@/lib/drafts/stale-sweep";

/**
 * Post-PRD hardening item 54 — daily stale-draft sweeper.
 *
 * Surfaces drafts whose `fcgWindowDeadline` has passed without
 * send/discard. One `draft_stale` notification per draft for its
 * lifetime (dispatch table dedupe). The FCG promised a response
 * window; this is how the engine refuses to silently break it.
 *
 * Same Bearer-auth shape as every other cron. Wire on Railway as:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/draft-stale
 *
 * Recommended schedule: `45 1 * * *` (01:45 UTC, after
 * channel-auth-expiry at 01:30 and before lifecycle-sweep at 02:00).
 * Locked by item 47's advisory-lock wrapper.
 */
export async function GET(req: Request) {
  const rl = await rateLimitByIp(req, "cron", 6, 60);
  if (!rl.allowed) return tooManyRequestsResponse(rl);

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  return cronJson(() => withCronHeartbeat("draft-stale", () => runDraftStaleSweep()));
}

export const POST = GET;
