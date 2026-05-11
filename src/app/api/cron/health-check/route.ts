import { NextResponse } from "next/server";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { runHealthCheck, withCronHeartbeat, cronJson } from "@/lib/cron-health";

/**
 * Post-PRD hardening item 22 — cron heartbeat monitoring worker.
 *
 * Evaluates every other registered cron's `CronHeartbeat` row and emits a
 * `CRON_STALLED` audit event + an immediate notification to Acumon
 * operators when a cron's `lastSuccessAt` has drifted past 2× its expected
 * interval, or its `consecutiveFailures` has reached the threshold.
 *
 * Same Bearer-auth shape as the other crons. Wire on Railway as a separate
 * cron service running every 15 minutes:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/health-check
 *
 * This worker ALSO writes its own heartbeat (via `withCronHeartbeat`) so
 * the /admin/health page can show whether health-check itself is alive —
 * but it deliberately does NOT alert on its own stall (because the alert
 * would be unread until it runs again). Operators rely on Railway's own
 * out-of-band alerting for that meta-case.
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
    withCronHeartbeat("health-check", async () => {
      const result = await runHealthCheck();
      return {
        evaluated: result.evaluated,
        alerted: result.alerted,
        alerts: result.alerts,
      };
    }),
  );
}

export const POST = GET;
