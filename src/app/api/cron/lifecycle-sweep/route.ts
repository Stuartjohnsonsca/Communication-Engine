import { NextResponse } from "next/server";
import { runLifecycleSweep } from "@/lib/lifecycle";
import { expireOverdueTias } from "@/lib/compliance/cross-border";
import { reapStaleRateLimitBuckets, rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";

/**
 * PRD §14.3 lifecycle sweep. Idempotent — only acts on rows whose grace
 * window has expired. Run on a schedule (Railway cron or any external
 * scheduler) using a shared secret in the `Authorization` header:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/lifecycle-sweep
 *
 * Returns counts so the scheduler log shows what moved.
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
  const result = await runLifecycleSweep();
  // PRD §12.6 — flip TIAs whose effectiveTo has passed to EXPIRED in the
  // same sweep so the cross-border view stays accurate without a second
  // cron service.
  const tia = await expireOverdueTias();
  // Reap rate-limit buckets that haven't been touched in a week. A
  // subsequent request just re-creates the row.
  const ratelimit = await reapStaleRateLimitBuckets();
  return NextResponse.json({
    ok: true,
    ...result,
    tiaExpired: tia.expired,
    rateLimitBucketsReaped: ratelimit.deleted,
  });
}

export const POST = GET;
