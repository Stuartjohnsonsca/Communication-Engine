import { NextResponse } from "next/server";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat, cronJson } from "@/lib/cron-health";
import { runAdherenceMonitor } from "@/lib/drafts/adherence-monitor";

/**
 * Post-PRD hardening item 71 — daily firm-adherence escalation.
 *
 * Iterates every tenant, computes the 7-day FCG-window adherence rate
 * via `computeDraftRollup` (same numbers as /admin/drafts), and fires a
 * mandatory `firm_adherence_below_threshold` notification to every
 * active FIRM_ADMIN when the rate is below `ADHERENCE_THRESHOLD` and
 * the volume floor (`MIN_DEADLINED_SENDS`) is met. dedupeKey is the
 * ISO week, so a tenant chronically below threshold gets one alert
 * per week, not one per cron tick.
 *
 * Same Bearer-auth shape as every other cron. Wire on Railway as:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/adherence-monitor
 *
 * Recommended schedule: `0 2 * * *` (02:00 UTC, after channel-auth-expiry
 * at 01:30 and draft-stale at 01:45). Locked by item 47's advisory-lock
 * wrapper.
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

  return cronJson(() =>
    withCronHeartbeat("adherence-monitor", () => runAdherenceMonitor()),
  );
}

export const POST = GET;
