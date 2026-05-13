import { NextResponse } from "next/server";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat, cronJson } from "@/lib/cron-health";
import { runFirmAckMonitor } from "@/lib/sentiment/firm-ack-monitor";

/**
 * Post-PRD hardening item 84 — daily firm-wide sentiment ack-rate
 * escalation. Sister cron to `adherence-monitor` (item 71) on the
 * sentiment side.
 *
 * Iterates every tenant, computes the 7-day sentiment ack-rate via
 * `computeSentimentMetrics` (same numbers as the /sentiment
 * response-time card from item 78), and fires a mandatory
 * `firm_sentiment_ack_rate_below_threshold` notification to every
 * active FIRM_ADMIN when the rate is below `ACK_RATE_THRESHOLD` and
 * the volume floor (`MIN_ESCALATED_FOR_ALERT`) is met. dedupeKey is
 * the ISO week so a tenant chronically below threshold gets one
 * alert per week, not one per cron tick.
 *
 * Same Bearer-auth shape as every other cron. Wire on Railway as:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/sentiment-firm-ack-monitor
 *
 * Recommended schedule: `0 3 * * *` (03:00 UTC, after item 71's
 * adherence-monitor at 02:00). Staggers the two governance crons
 * onto adjacent slots so a single Railway worker can serve both
 * without overlap. Locked by item 47's advisory-lock wrapper.
 */
export async function GET(req: Request) {
  const rl = await rateLimitByIp(req, "cron", 6, 60);
  if (!rl.allowed) return tooManyRequestsResponse(rl);

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  return cronJson(() =>
    withCronHeartbeat("sentiment-firm-ack-monitor", () => runFirmAckMonitor()),
  );
}

export const POST = GET;
