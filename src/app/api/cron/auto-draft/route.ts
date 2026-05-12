import { NextResponse } from "next/server";
import { runAutoDraftSweep } from "@/lib/drafts";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat, cronJson } from "@/lib/cron-health";

/**
 * Post-PRD hardening item 50 — continuous-background draft producer.
 *
 * The Communication Engine drafts inbound responses without a User
 * pressing a button: the cron scans `IngestedMessage` rows where
 * direction=IN and no Draft is linked, then runs the same drafting
 * agent the manual `/api/ai/draft` path uses. The FCG drives the
 * cadence (acknowledgment vs substantive, time windows); the engine
 * never sends — the User still presses send.
 *
 * Same Bearer-auth shape as every other cron. Wire on Railway with:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/auto-draft
 *
 * Recommended schedule: every 5 minutes. Item 47's advisory-lock
 * wrapper means a slower invocation overlapping a faster one is a
 * no-op rather than a duplicate run.
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
    withCronHeartbeat("auto-draft", () => runAutoDraftSweep()),
  );
}

export const POST = GET;
