import { NextResponse } from "next/server";
import { runLifecycleSweep } from "@/lib/lifecycle";
import { expireOverdueTias } from "@/lib/compliance/cross-border";
import { reapStaleRateLimitBuckets, rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { reapOldDeliveries } from "@/lib/webhooks";
import { sweepExpiredSessions } from "@/lib/auth/sessions";
import { sweepInactiveOrExpiredApiKeys } from "@/lib/auth/api-keys";
import { withCronHeartbeat } from "@/lib/cron-health";
import { processDueChanges } from "@/lib/subprocessors";

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
  const payload = await withCronHeartbeat("lifecycle-sweep", async () => {
    const result = await runLifecycleSweep();
    // PRD §12.6 — flip TIAs whose effectiveTo has passed to EXPIRED in the
    // same sweep so the cross-border view stays accurate without a second
    // cron service.
    const tia = await expireOverdueTias();
    // Reap rate-limit buckets that haven't been touched in a week. A
    // subsequent request just re-creates the row.
    const ratelimit = await reapStaleRateLimitBuckets();
    // Reap webhook deliveries — DELIVERED rows older than 30 days, dead-
    // lettered rows older than 90 days. Receivers shouldn't depend on the
    // delivery log for primary state; the audit chain is the source of truth.
    const webhooks = await reapOldDeliveries();
    // Post-PRD hardening item 15 — auto-revoke sessions that breached the
    // per-tenant idle or absolute timeout. The layout-level enforcer catches
    // returning Users on their next page load; this sweep catches sessions
    // whose User never came back (laptop closed, browser tab abandoned)
    // so the row is genuinely revoked rather than just rejected next visit.
    const sessions = await sweepExpiredSessions();
    // Post-PRD hardening item 16 — auto-revoke API keys whose creator-
    // Membership has gone INACTIVE, or whose `expiresAt` has passed.
    const apiKeys = await sweepInactiveOrExpiredApiKeys();
    // Post-PRD hardening item 24 — auto-promote sub-processor changes whose
    // 30-day (or operator-set) notice window has elapsed. Idempotent;
    // confirmChange is a no-op when the change has already been promoted
    // (e.g. an Acumon operator clicked "Confirm now" earlier).
    const subprocessors = await processDueChanges();
    return {
      ...result,
      tiaExpired: tia.expired,
      rateLimitBucketsReaped: ratelimit.deleted,
      webhookDeliveriesReaped: webhooks.deleted,
      sessionsTimedOut: sessions.revoked,
      sessionsTimedOutByReason: sessions.reasons,
      apiKeysRevokedForInactivity: apiKeys.revokedForInactivity,
      apiKeysRevokedForExpiry: apiKeys.revokedForExpiry,
      subprocessorChangesConsidered: subprocessors.considered,
      subprocessorChangesConfirmed: subprocessors.confirmed,
    };
  });
  return NextResponse.json({ ok: true, ...payload });
}

export const POST = GET;
