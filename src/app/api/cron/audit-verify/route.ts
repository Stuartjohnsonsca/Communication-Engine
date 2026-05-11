import { NextResponse } from "next/server";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat, cronJson } from "@/lib/cron-health";
import { runChainVerificationPass } from "@/lib/audit-verify";

/**
 * Post-PRD hardening item 23 — daily background verification of every
 * tenant's audit chain.
 *
 * Same Bearer-auth shape as the other crons. Wire on Railway as a daily
 * cron service:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/audit-verify
 *
 * Recommended schedule: `30 2 * * *` (02:30 UTC, after lifecycle-sweep at
 * 02:00 to avoid contention; well before billing-close at 03:05 on the
 * 1st of the month). Idempotent — every pass writes its own
 * AuditChainVerification row; tamper alerts dedupe per (tenant,
 * failedAtSeq) within a 7-day window.
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
    withCronHeartbeat("audit-verify", async () => {
      const result = await runChainVerificationPass();
      // Serialise outcomes so BigInt failedAtSeq survives JSON.
      const outcomes = result.outcomes.map((o) => ({
        ...o,
        failedAtSeq: o.failedAtSeq === null ? null : Number(o.failedAtSeq),
      }));
      return {
        evaluated: result.evaluated,
        okCount: result.ok,
        tampered: result.tampered,
        errored: result.errored,
        outcomes,
      };
    }),
  );
}

export const POST = GET;
