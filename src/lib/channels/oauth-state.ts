import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/**
 * Backlog item 3 — HMAC-signed OAuth `state` value.
 *
 * Two reasons this exists:
 *   1. CSRF / forgery: without a signature, anyone could forge a callback
 *      with a chosen `state` and bind their own mailbox to a target
 *      tenant's channel. Signing with a server-side secret prevents this.
 *   2. Membership attribution: the connect route knows which Membership
 *      kicked off the OAuth dance; the callback runs unauthenticated
 *      (it's the OAuth provider redirecting back). Round-tripping the
 *      membershipId through state is how `ChannelAuth.membershipId` ends
 *      up populated for real-OAuth connections — without which the
 *      synthesise-from-outbound compliance gate (item 1) skips with
 *      "no authenticated membership on channel".
 *
 * Shape: `<channelId>.<tenantSlug>.<membershipId>.<expiresAtUnixSec>.<nonce>.<sigHex>`
 *
 * Signature covers the first five segments joined by `.`.
 *
 * Secret source: `NEXTAUTH_SECRET` (already required in this deployment for
 * session signing). Falling back to `ENCRYPTION_KEY` keeps test envs
 * working.
 */

const SEP = ".";
const TTL_SECONDS = 10 * 60;

function secret(): Buffer {
  const raw = process.env.NEXTAUTH_SECRET ?? process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("NEXTAUTH_SECRET (or ENCRYPTION_KEY) must be set to sign OAuth state");
  return Buffer.from(raw, "utf8");
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function signOAuthState(args: {
  channelId: string;
  tenantSlug: string;
  membershipId: string;
}): string {
  for (const v of Object.values(args)) {
    if (!v || v.includes(SEP)) {
      throw new Error("oauth state segment must be non-empty and contain no '.'");
    }
  }
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const nonce = randomBytes(8).toString("hex");
  const payload = [args.channelId, args.tenantSlug, args.membershipId, expiresAt, nonce].join(SEP);
  return `${payload}${SEP}${sign(payload)}`;
}

export type VerifiedOAuthState = {
  channelId: string;
  tenantSlug: string;
  membershipId: string;
};

export function verifyOAuthState(state: string): VerifiedOAuthState {
  const parts = state.split(SEP);
  if (parts.length !== 6) throw new Error("oauth state malformed");
  const [channelId, tenantSlug, membershipId, expiresAtStr, nonce, providedSig] = parts;
  const payload = [channelId, tenantSlug, membershipId, expiresAtStr, nonce].join(SEP);
  const expected = sign(payload);
  const a = Buffer.from(providedSig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("oauth state signature mismatch");
  }
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    throw new Error("oauth state expired");
  }
  return { channelId, tenantSlug, membershipId };
}
