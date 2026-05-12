import { NextResponse } from "next/server";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";
import { withCronHeartbeat, cronJson } from "@/lib/cron-health";
import { runChannelAuthExpiryCheck } from "@/lib/channels/expiry-check";

/**
 * Post-PRD hardening item 53 — daily channel-auth expiry warning.
 *
 * Scans every ACTIVE ChannelAuth with `expiresAt` inside 7 days, fires
 * one `channel_auth_expiring` notification per (auth, threshold)
 * pairing, and writes a `CHANNEL_AUTH_EXPIRY_WARNED` audit row on the
 * owning tenant's chain. Idempotent via the dispatch table's
 * uniqueness constraint — running daily produces exactly one warning
 * per threshold per token.
 *
 * Same Bearer-auth shape as every other cron. Wire on Railway as:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<host>/api/cron/channel-auth-expiry
 *
 * Recommended schedule: `30 1 * * *` (01:30 UTC, before the 02:00
 * lifecycle-sweep and 02:30 audit-verify crons). Locked by item 47's
 * advisory-lock wrapper.
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
    withCronHeartbeat("channel-auth-expiry", () => runChannelAuthExpiryCheck()),
  );
}

export const POST = GET;
