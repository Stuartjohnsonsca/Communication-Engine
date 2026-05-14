import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { meta } from "@/lib/channels/registry";
import { encryptJson } from "@/lib/channels/crypto";
import { getTenantOAuthApp } from "@/lib/channels/oauth-apps";
import { signOAuthState } from "@/lib/channels/oauth-state";
import { writeAuditEvent } from "@/lib/audit";

const inputSchema = z.object({
  tenantSlug: z.string(),
  /** "real" (start OAuth dance) or "mock" (synthesise tokens for demo). */
  mode: z.enum(["real", "mock"]).default("mock"),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = await getTenantContext(parsed.data.tenantSlug);
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission(ctx.membership.role, "channels:write");

  const channel = await superDb.channel.findFirst({
    where: { id, tenantId: ctx.tenant.id },
  });
  if (!channel) return NextResponse.json({ error: "not found" }, { status: 404 });

  const m = meta(channel.kind);

  if (parsed.data.mode === "real" && m.oauthAuthorizeUrl) {
    // Item 101 — resolve per-tenant OAuth app first (multi-tenant
    // SaaS posture), fall back to env-var defaults only for dev /
    // single-tenant deploys. If neither is present return a clear
    // configuration error rather than silently falling through to
    // mock mode (a mock token in production would break ingest
    // invisibly).
    const tenantApp = await getTenantOAuthApp(channel.tenantId, channel.kind);
    const platformClientId = m.clientId?.();
    const effectiveClientId = tenantApp?.clientId ?? platformClientId ?? null;
    if (!effectiveClientId) {
      return NextResponse.json(
        {
          error:
            `OAuth for ${channel.kind} is not configured for this tenant. ` +
            `A FIRM_ADMIN must add the client_id + client_secret on /admin/channels/oauth-apps.`,
        },
        { status: 503 },
      );
    }
    // State is HMAC-signed (see oauth-state.ts) and carries the
    // membershipId so the callback can attribute the connection back
    // to the User who initiated it. Without that round-trip,
    // ChannelAuth.membershipId is null on real OAuth, which makes
    // synthesise-from-outbound skip every send with "no
    // authenticated membership on channel".
    const state = signOAuthState({
      channelId: channel.id,
      tenantSlug: parsed.data.tenantSlug,
      membershipId: ctx.membership.id,
    });
    const url = new URL(m.oauthAuthorizeUrl());
    url.searchParams.set("client_id", effectiveClientId);
    url.searchParams.set("redirect_uri", buildRedirectUri(req));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", m.scopeDefault.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return NextResponse.json({ redirectTo: url.toString() });
  }

  // Mock mode (or real-mode for a kind without OAuth wired in this env):
  // synthesise a token, mark the channel ACTIVE and dpiaApproved=false.
  const tokens = {
    mock: true,
    access_token: `mock-${channel.kind}-${channel.id}`,
    expires_at: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
  };
  await superDb.channelAuth.create({
    data: {
      tenantId: ctx.tenant.id,
      channelId: channel.id,
      membershipId: ctx.membership.id,
      encryptedTokens: encryptJson(tokens),
      scope: m.scopeDefault.join(" "),
      expiresAt: new Date(tokens.expires_at * 1000),
    },
  });
  await superDb.channel.update({
    where: { id: channel.id },
    data: { status: "ACTIVE" },
  });

  await writeAuditEvent({
    tenantId: ctx.tenant.id,
    eventType: "CHANNEL_AUTHORISED",
    actorMembershipId: ctx.membership.id,
    subjectType: "Channel",
    subjectId: channel.id,
    payload: { kind: channel.kind, mode: "mock" },
  });

  return NextResponse.json({ ok: true, mode: "mock" });
}

function buildRedirectUri(req: Request) {
  const url = new URL(req.url);
  return `${url.origin}/api/channels/oauth-callback`;
}
