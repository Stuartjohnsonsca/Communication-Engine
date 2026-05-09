import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant";
import { superDb } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { meta } from "@/lib/channels/registry";
import { encryptJson } from "@/lib/channels/crypto";
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

  if (parsed.data.mode === "real" && m.realOAuthAvailable() && m.oauthAuthorizeUrl && m.clientId) {
    // Real OAuth handshake — return the URL to redirect to. State carries
    // channelId + tenantSlug so the callback can resolve back. (For a full
    // production build this state should be HMAC-signed with NEXTAUTH_SECRET.)
    const url = new URL(m.oauthAuthorizeUrl());
    url.searchParams.set("client_id", m.clientId() ?? "");
    url.searchParams.set("redirect_uri", buildRedirectUri(req));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", m.scopeDefault.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", `${channel.id}:${parsed.data.tenantSlug}`);
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
