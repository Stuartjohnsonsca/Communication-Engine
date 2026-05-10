import { NextResponse } from "next/server";
import { runWeeklyDigest } from "@/lib/notifications";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";

/**
 * Backlog item 6 — weekly notification digest.
 *
 * Same auth shape as the other cron entries (Authorization: Bearer
 * $CRON_SECRET). Idempotent: each membership's digest is keyed on the ISO
 * week so a flaky scheduler retry within the same week is a no-op. The
 * scheduler should fire every Monday at 09:00 UTC; the dedupe key absorbs
 * any timezone variance for Clients that aren't in the UK.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/digest
 */
export async function GET(req: Request) {
  // Belt + braces — the Bearer check below is the primary gate, but a
  // per-IP cap means a leaked secret can't be brute-forced against a
  // hot-path digest run.
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
  const result = await runWeeklyDigest();
  return NextResponse.json({ ok: true, ...result });
}

export const POST = GET;
