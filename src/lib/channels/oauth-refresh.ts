import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { encryptJson, decryptJson } from "./crypto";
import { meta } from "./registry";
import type { Tokens } from "./adapters/types";

/**
 * Backlog item 3 — provider-generic OAuth access-token refresh.
 *
 * Both Google and Microsoft 365 issue access tokens that expire in
 * roughly an hour. Without a refresh path the channel breaks the moment
 * an access_token expires, regardless of whether the long-lived
 * refresh_token is still valid. This module is called from `runIngest`
 * before the adapter runs: if the token is missing, near-expiry, or
 * already-expired, we exchange the refresh_token for a fresh access
 * token, update the encrypted blob in place, and continue.
 *
 * Hard refresh failure (refresh_token revoked, account suspended, scope
 * changed) flips the channel to `REFRESH_FAILED` and revokes the auth
 * row. The User must re-run the OAuth dance.
 */

const REFRESH_SKEW_SECONDS = 60;

export type RefreshOutcome =
  | { result: "fresh"; tokens: Tokens }
  | { result: "refreshed"; tokens: Tokens }
  | { result: "no-refresh-token"; tokens: Tokens }
  | { result: "no-tokens"; tokens: Tokens }
  | { result: "failed"; error: string };

/**
 * Ensure the auth row's tokens are usable. Returns the tokens to pass
 * into the adapter. Mutates ChannelAuth + Channel + writes audit on
 * refresh success/failure. Never throws — callers can fall through to
 * the mock adapter if the result is `failed`.
 */
export async function ensureFreshTokens(channelAuthId: string): Promise<RefreshOutcome> {
  const auth = await superDb.channelAuth.findUnique({
    where: { id: channelAuthId },
    include: { channel: true },
  });
  if (!auth || auth.revokedAt) {
    return { result: "no-tokens", tokens: {} };
  }

  let tokens: Tokens = {};
  try {
    tokens = decryptJson<Tokens>(auth.encryptedTokens);
  } catch {
    return { result: "no-tokens", tokens: {} };
  }

  if (tokens.mock) return { result: "fresh", tokens };
  if (!tokens.access_token) return { result: "no-tokens", tokens };

  const now = Math.floor(Date.now() / 1000);
  const stillValid =
    typeof tokens.expires_at === "number"
      ? tokens.expires_at - REFRESH_SKEW_SECONDS > now
      : true; // unknown expiry — try the call optimistically
  if (stillValid) return { result: "fresh", tokens };

  if (!tokens.refresh_token) return { result: "no-refresh-token", tokens };

  const m = meta(auth.channel.kind);
  if (!m.oauthTokenUrl) return { result: "no-refresh-token", tokens };

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: m.clientId?.() ?? "",
    client_secret: clientSecretFor(auth.channel.kind) ?? "",
  });

  const res = await fetch(m.oauthTokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!res.ok) {
    const errBody = await res.text();
    await superDb.channelAuth.update({
      where: { id: auth.id },
      data: { revokedAt: new Date() },
    });
    await superDb.channel.update({
      where: { id: auth.channelId },
      data: { status: "REFRESH_FAILED" },
    });
    await writeAuditEvent({
      tenantId: auth.tenantId,
      eventType: "CHANNEL_TOKEN_REFRESH_FAILED",
      actorMembershipId: auth.membershipId,
      subjectType: "Channel",
      subjectId: auth.channelId,
      payload: { kind: auth.channel.kind, status: res.status, body: truncate(errBody, 500) },
    });
    return { result: "failed", error: `refresh ${res.status}: ${truncate(errBody, 200)}` };
  }

  const tok = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  // Some providers (Google included) don't return a fresh refresh_token
  // every time; keep the prior one if a new one isn't supplied.
  const merged: Tokens = {
    access_token: tok.access_token ?? tokens.access_token,
    refresh_token: tok.refresh_token ?? tokens.refresh_token,
    expires_at: tok.expires_in ? now + tok.expires_in : tokens.expires_at,
    scope: tok.scope ?? tokens.scope,
  };

  await superDb.channelAuth.update({
    where: { id: auth.id },
    data: {
      encryptedTokens: encryptJson(merged),
      scope: merged.scope ?? auth.scope,
      expiresAt: merged.expires_at ? new Date(merged.expires_at * 1000) : auth.expiresAt,
    },
  });

  await writeAuditEvent({
    tenantId: auth.tenantId,
    eventType: "CHANNEL_TOKEN_REFRESHED",
    actorMembershipId: auth.membershipId,
    subjectType: "Channel",
    subjectId: auth.channelId,
    payload: { kind: auth.channel.kind, expiresAt: merged.expires_at },
  });

  return { result: "refreshed", tokens: merged };
}

function clientSecretFor(kind: string): string | undefined {
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

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
