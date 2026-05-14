import { NextResponse } from "next/server";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat, cronJson } from "@/lib/cron-health";
import { runFirmAdherenceAckMonitor } from "@/lib/adherence/firm-ack-monitor";

/**
 * Post-PRD hardening item 95 — daily firm-wide adherence-escalation
 * ack-rate alert. Adherence-pillar analog of item 84's
 * `sentiment-firm-ack-monitor` and sister to item 71's
 * `adherence-monitor` (which measures FCG-WINDOW adherence — a
 * different question).
 *
 * Iterates every tenant, computes the 7-day adherence-escalation
 * ack-rate via `computeAdherenceMetrics` (same numbers as the
 * /adherence/escalations response-time card from items 90 + 91), and
 * fires a mandatory `firm_adherence_ack_rate_below_threshold`
 * notification to every active FIRM_ADMIN when the rate is below
 * `ACK_RATE_THRESHOLD` and the volume floor
 * (`MIN_ESCALATED_FOR_ALERT`) is met. dedupeKey is the ISO week so a
 * tenant chronically below threshold gets one alert per week, not one
 * per cron tick.
 *
 * Same Bearer-auth shape as every other cron. Wire on Railway as:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/adherence-firm-ack-monitor
 *
 * Recommended schedule: `0 4 * * *` (04:00 UTC, after item 84's
 * sentiment-firm-ack-monitor at 03:00 and item 71's adherence-monitor
 * at 02:00). Three firm-wide governance crons on adjacent hourly
 * slots so a single Railway worker serves them without overlap.
 * Locked by item 47's advisory-lock wrapper.
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
    withCronHeartbeat("adherence-firm-ack-monitor", () =>
      runFirmAdherenceAckMonitor(),
    ),
  );
}

export const POST = GET;
