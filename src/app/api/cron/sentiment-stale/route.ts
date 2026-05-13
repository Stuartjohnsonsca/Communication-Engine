import { NextResponse } from "next/server";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat, cronJson } from "@/lib/cron-health";
import { runSentimentStaleSweep } from "@/lib/sentiment/stale-sweep";

/**
 * Post-PRD hardening item 77 — stale-sentiment-escalation sweeper.
 *
 * Re-notifies the original audience when a PRD §9.3 sentiment
 * escalation has been left unacknowledged for `STALE_THRESHOLD_HOURS`.
 * One nudge per signal, ever — audit chain is the dedupe gate.
 *
 * Same Bearer-auth shape as every other cron. Wire on Railway as:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/sentiment-stale
 *
 * Recommended schedule: `15 * * * *` (every hour at :15 — keeps it off
 * the daily-cron stack at 01:00–02:00 and bounds the nudge to within
 * an hour of the 4h stale mark). Locked by item 47's advisory-lock
 * wrapper.
 */
export async function GET(req: Request) {
  const rl = await rateLimitByIp(req, "cron", 60, 60);
  if (!rl.allowed) return tooManyRequestsResponse(rl);

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  return cronJson(() =>
    withCronHeartbeat("sentiment-stale", () => runSentimentStaleSweep()),
  );
}

export const POST = GET;
