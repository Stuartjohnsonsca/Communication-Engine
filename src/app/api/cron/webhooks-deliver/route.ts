import { NextResponse } from "next/server";
import { runWebhookDeliveryBatch } from "@/lib/webhooks";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat } from "@/lib/cron-health";

/**
 * Post-PRD hardening item 14 — outbound webhook delivery worker.
 *
 * Same auth shape as the other cron entries (Authorization: Bearer
 * $CRON_SECRET). Drains PENDING WebhookDelivery rows whose `scheduledFor`
 * has passed, POSTs to the receiver with an HMAC-signed body, retries with
 * exponential backoff, and dead-letters after `maxAttempts`.
 *
 * The scheduler should fire this every minute. Concurrency-safe — even if
 * two workers race, the IN_FLIGHT lock means at most one will deliver any
 * single row per pass.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/webhooks-deliver
 */
export async function GET(req: Request) {
  // Belt + braces — the Bearer check below is the primary gate, but a
  // per-IP cap means a leaked secret can't be used to flood the worker.
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
  const result = await withCronHeartbeat("webhooks-deliver", () => runWebhookDeliveryBatch());
  return NextResponse.json({ ok: true, ...result });
}

export const POST = GET;
