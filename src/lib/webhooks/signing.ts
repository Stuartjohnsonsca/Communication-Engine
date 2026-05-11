import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * HMAC signing for outbound webhook bodies.
 *
 * Stripe-style header: `X-Acumon-Signature: t=<unix-seconds>,v1=<hex>`.
 * The receiver re-computes `HMAC-SHA256(secret, "<t>.<body>")` and uses a
 * constant-time compare against the v1 hex. Including the timestamp inside
 * the signed material defeats replay across a stolen body — receivers
 * should additionally reject signatures whose `t` is more than ~5 minutes
 * old.
 *
 * Plaintext secrets never leave this module — callers pass the secret as a
 * raw string and pass the body bytes verbatim. Storage of the secret at
 * rest is the caller's concern (see `src/lib/webhooks/subscriptions.ts`,
 * which encrypts via `src/lib/channels/crypto.ts encryptJson`).
 */

export const SIGNATURE_HEADER = "X-Acumon-Signature";
export const EVENT_HEADER = "X-Acumon-Event";
export const DELIVERY_HEADER = "X-Acumon-Delivery";

export function generateSecret(): string {
  // 32 bytes of entropy, hex-encoded — fits easily in a `secretEncrypted`
  // TEXT column after AES-GCM and base64.
  return randomBytes(32).toString("hex");
}

export function signBody(input: {
  secret: string;
  body: string;
  /** Defaults to now(); overridable for testability. */
  timestampSeconds?: number;
}): string {
  return signBodyMulti({
    secrets: [input.secret],
    body: input.body,
    timestampSeconds: input.timestampSeconds,
  });
}

/**
 * Multi-secret signing for the rotation grace window (item 46). When a
 * subscription has both a current and a previous secret, the dispatcher
 * sends one signature per secret in the same `t=…` header — receivers
 * iterate the `v1=` segments and accept the first valid match. Stripe's
 * convention; backward compatible with single-sig receivers who only
 * inspect the first `v1=` (they'll just see the current secret's
 * signature, which is what they want).
 *
 * Order matters: the CURRENT secret's signature comes first. A receiver
 * that hasn't been updated yet still works during the grace window
 * because we ALSO emit the previous secret's signature in a second
 * `v1=` segment.
 */
export function signBodyMulti(input: {
  secrets: string[];
  body: string;
  timestampSeconds?: number;
}): string {
  if (input.secrets.length === 0) {
    throw new Error("signBodyMulti: at least one secret required");
  }
  const t = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const sigs = input.secrets.map((s) => `v1=${computeV1(s, t, input.body)}`);
  return `t=${t},${sigs.join(",")}`;
}

function computeV1(secret: string, t: number, body: string): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

/**
 * Verify a header against the body + secret. Used by the integration tests
 * (and is the algorithm a receiver implements). `toleranceSeconds` defaults
 * to 5 minutes — past that we treat the signature as too old to trust.
 */
export function verifySignature(input: {
  header: string;
  secret: string;
  body: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const parts = parseHeader(input.header);
  if (!parts) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 5 * 60;
  if (Math.abs(now - parts.t) > tolerance) return false;
  const expected = computeV1(input.secret, parts.t, input.body);
  const expectedBuf = Buffer.from(expected, "hex");
  // Iterate every `v1=` segment so a receiver that only knows one of
  // the rotation pair's secrets still accepts the body during the
  // grace window. Constant-time compare against each candidate;
  // exit early on the first match.
  for (const candidate of parts.v1s) {
    const givenBuf = Buffer.from(candidate, "hex");
    if (expectedBuf.length !== givenBuf.length) continue;
    if (timingSafeEqual(expectedBuf, givenBuf)) return true;
  }
  return false;
}

function parseHeader(header: string): { t: number; v1s: string[] } | null {
  // Format: "t=<int>,v1=<hex>[,v1=<hex>...]" — small, fixed grammar.
  // Multiple v1 segments are produced during a rotation grace window
  // (item 46); receivers should accept any one of them.
  const segments = header.split(",").map((s) => s.trim());
  let t: number | undefined;
  const v1s: string[] = [];
  for (const seg of segments) {
    const eq = seg.indexOf("=");
    if (eq < 1) continue;
    const k = seg.slice(0, eq);
    const v = seg.slice(eq + 1);
    if (k === "t") {
      const parsed = Number.parseInt(v, 10);
      if (Number.isFinite(parsed)) t = parsed;
    } else if (k === "v1") {
      if (/^[0-9a-f]+$/i.test(v)) v1s.push(v);
    }
  }
  if (t === undefined || v1s.length === 0) return null;
  return { t, v1s };
}
