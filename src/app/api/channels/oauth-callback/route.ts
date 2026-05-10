import { NextResponse } from "next/server";
import { superDb } from "@/lib/db";
import { meta } from "@/lib/channels/registry";
import { encryptJson } from "@/lib/channels/crypto";
import { verifyOAuthState } from "@/lib/channels/oauth-state";
import { writeAuditEvent } from "@/lib/audit";
import { rateLimitByIp, tooManyRequestsResponse } from "@/lib/ratelimit";

/**
 * Generic OAuth 2.0 authorization-code callback.
 *
 * Backlog item 3 — state is now HMAC-signed and carries
 * `<channelId>.<tenantSlug>.<membershipId>.<expiresAt>.<nonce>.<sig>`.
 * Forged or expired callbacks are rejected before any token is
 * persisted. The membershipId is what allows the bypassed-send
 * compliance gate (item 1) to attribute scoring to the right User —
 * without it, real-OAuth ChannelAuth rows had `membershipId = null`
 * and synthesise-from-outbound silently skipped every send.
 */
export async function GET(req: Request) {
  // Pre-tenant-resolution surface — the only identity we have is the IP.
  // 20/min per IP comfortably absorbs legitimate retries while caging
  // an attacker who's brute-forcing channel ids + state guesses.
  const rl = await rateLimitByIp(req, "oauth-callback", 20, 60);
  if (!rl.allowed) return tooManyRequestsResponse(rl);

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state") ?? "";
  if (!code || !stateRaw) {
    return NextResponse.json({ error: "invalid callback" }, { status: 400 });
  }

  let verified;
  try {
    verified = verifyOAuthState(stateRaw);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "state verification failed" },
      { status: 403 },
    );
  }
  const { channelId, tenantSlug, membershipId } = verified;

  const channel = await superDb.channel.findUnique({ where: { id: channelId } });
  if (!channel) return NextResponse.json({ error: "channel not found" }, { status: 404 });
  const tenant = await superDb.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant || tenant.id !== channel.tenantId) {
    return NextResponse.json({ error: "tenant mismatch" }, { status: 403 });
  }
  const membership = await superDb.membership.findUnique({ where: { id: membershipId } });
  if (!membership || membership.tenantId !== tenant.id) {
    return NextResponse.json({ error: "membership mismatch" }, { status: 403 });
  }
  const m = meta(channel.kind);
  if (!m.oauthTokenUrl || !m.clientId || !m.realOAuthAvailable()) {
    return NextResponse.json({ error: "channel kind has no OAuth in this deployment" }, { status: 400 });
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: m.clientId() ?? "",
    client_secret: clientSecret(channel.kind) ?? "",
    redirect_uri: `${url.origin}/api/channels/oauth-callback`,
  });
  const tokenRes = await fetch(m.oauthTokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!tokenRes.ok) {
    return NextResponse.json(
      { error: `token exchange ${tokenRes.status}: ${await tokenRes.text()}` },
      { status: 502 },
    );
  }
  const tok = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  await superDb.channelAuth.create({
    data: {
      tenantId: channel.tenantId,
      channelId: channel.id,
      membershipId,
      encryptedTokens: encryptJson({
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: tok.expires_in ? Math.floor(Date.now() / 1000) + tok.expires_in : undefined,
        scope: tok.scope,
      }),
      scope: tok.scope ?? m.scopeDefault.join(" "),
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
    },
  });
  await superDb.channel.update({ where: { id: channel.id }, data: { status: "ACTIVE" } });

  await writeAuditEvent({
    tenantId: channel.tenantId,
    eventType: "CHANNEL_AUTHORISED",
    actorMembershipId: membershipId,
    subjectType: "Channel",
    subjectId: channel.id,
    payload: { kind: channel.kind, mode: "oauth", hasRefreshToken: Boolean(tok.refresh_token) },
  });

  return NextResponse.redirect(`${url.origin}/${tenantSlug}/admin/channels`);
}

function clientSecret(kind: string): string | undefined {
  switch (kind) {
    case "M365":
    case "TEAMS":
    case "SHAREPOINT":
      return process.env.M365_CLIENT_SECRET;
    case "GOOGLE":
      return process.env.GOOGLE_CLIENT_SECRET;
    case "SLACK":
      return process.env.SLACK_CLIENT_SECRET;
    default:
      return undefined;
  }
}
