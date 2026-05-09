import { NextResponse } from "next/server";
import { superDb } from "@/lib/db";
import { meta } from "@/lib/channels/registry";
import { encryptJson } from "@/lib/channels/crypto";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Generic OAuth 2.0 authorization-code callback.
 *
 * The state value is `<channelId>:<tenantSlug>`, which we round-trip from
 * the connect route. Real production would HMAC-sign this; for a Phase 2
 * build we resolve the channel by id and re-validate against tenantSlug.
 *
 * On success we encrypt the token blob, mark the channel ACTIVE, write an
 * audit event, and bounce the user back to the admin/channels page.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const [channelId, tenantSlug] = state.split(":");
  if (!code || !channelId || !tenantSlug) {
    return NextResponse.json({ error: "invalid callback" }, { status: 400 });
  }

  const channel = await superDb.channel.findUnique({ where: { id: channelId } });
  if (!channel) return NextResponse.json({ error: "channel not found" }, { status: 404 });
  const tenant = await superDb.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant || tenant.id !== channel.tenantId) {
    return NextResponse.json({ error: "tenant mismatch" }, { status: 403 });
  }
  const m = meta(channel.kind);
  if (!m.oauthTokenUrl || !m.clientId || !m.realOAuthAvailable()) {
    return NextResponse.json({ error: "channel kind has no OAuth in this deployment" }, { status: 400 });
  }

  // Exchange code → tokens
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
    return NextResponse.json({ error: `token exchange ${tokenRes.status}: ${await tokenRes.text()}` }, { status: 502 });
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
      encryptedTokens: encryptJson({
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: tok.expires_in ? Math.floor(Date.now() / 1000) + tok.expires_in : undefined,
      }),
      scope: tok.scope ?? m.scopeDefault.join(" "),
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
    },
  });
  await superDb.channel.update({ where: { id: channel.id }, data: { status: "ACTIVE" } });

  await writeAuditEvent({
    tenantId: channel.tenantId,
    eventType: "CHANNEL_AUTHORISED",
    actorMembershipId: null,
    subjectType: "Channel",
    subjectId: channel.id,
    payload: { kind: channel.kind, mode: "oauth" },
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
