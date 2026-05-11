import { NextResponse } from "next/server";
import { closeAllDueBillingPeriods } from "@/lib/billing";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat } from "@/lib/cron-health";

/**
 * PRD §15.1 monthly close. Closes the previous calendar month's
 * BillingPeriod for every active/sandbox tenant. Idempotent — re-running
 * the same day is a no-op for tenants whose previous-month period is
 * already CLOSED.
 *
 * Wire on Railway as a cron service hitting:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/billing-close
 *
 * Recommended schedule: `5 3 1 * *` (03:05 on the 1st of each month, UTC).
 * The hour offset from the lifecycle sweep avoids contention.
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
  const result = await withCronHeartbeat("billing-close", () =>
    closeAllDueBillingPeriods(),
  );
  return NextResponse.json({ ok: true, ...result });
}

export const POST = GET;
