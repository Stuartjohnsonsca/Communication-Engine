import { NextResponse } from "next/server";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat, cronJson } from "@/lib/cron-health";
import { runAdherenceStaleSweep } from "@/lib/adherence/stale-sweep";

/**
 * Post-PRD hardening item 99 — stale-adherence-escalation sweeper.
 *
 * Adherence-pillar analog of item 77's `/api/cron/sentiment-stale`.
 * Re-notifies the original audience when a backlog-item-1 adherence
 * escalation has been left unacknowledged for `STALE_THRESHOLD_HOURS`
 * (4h). One nudge per CommunicationAdherence row, ever — audit chain
 * is the dedupe gate.
 *
 * Same Bearer-auth shape as every other cron. Wire on Railway as:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/adherence-stale
 *
 * Recommended schedule: `30 * * * *` (every hour at :30 — keeps it off
 * the daily-cron stack at 01:00–04:00 AND off the sister sentiment
 * sweep's `:15` slot to spread DB load across the hour). Locked by
 * item 47's advisory-lock wrapper.
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
    withCronHeartbeat("adherence-stale", () => runAdherenceStaleSweep()),
  );
}

export const POST = GET;
