import { NextResponse } from "next/server";
import { runHardDeletionSweep } from "@/lib/termination";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat } from "@/lib/cron-health";

/**
 * PRD §14.4 hard-deletion sweep. Idempotent — only acts on tenants whose
 * `terminationEffectiveAt` has passed and `terminationCompletedAt` is null.
 * Run on a schedule (Railway cron or any external scheduler) using a shared
 * secret in the `Authorization` header:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/termination
 *
 * Returns counts so the scheduler log shows what was deleted.
 *
 * §12.5 retention is built into the sweep: AuditEvent + DPIAAttestation are
 * preserved; the Tenant row stays as TERMINATED until the statutory
 * retention period elapses (default 6 years).
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
  const result = await withCronHeartbeat("termination", () => runHardDeletionSweep());
  return NextResponse.json({ ok: true, ...result });
}

export const POST = GET;
