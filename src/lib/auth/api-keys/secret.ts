import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { base32Encode } from "@/lib/auth/totp/base32";

/**
 * Issued API key format:
 *
 *     ack_<prefix>_<secret>
 *
 * - `ack_` is the constant brand prefix so the key is recognisable at a
 *   glance in code reviews and chat logs (and so secret-scanners like
 *   GitHub's can pattern-match it).
 * - `<prefix>` is 13 base32 chars carrying ~64 bits of entropy. UNIQUE
 *   in the database and stored in plaintext — it's the lookup index.
 * - `<secret>` is 32 base32 chars carrying 160 bits of entropy. NOT
 *   stored; only an HMAC of (prefix || "." || secret) is.
 *
 * Total entropy is 224 bits, well above the 128-bit floor recommended
 * for long-lived bearer tokens. Length is comparable to a Stripe
 * `sk_live_…` or GitHub `ghp_…`.
 *
 * `ack` stands for Acumon Communications Key. Distinct from `acumon_` so
 * webhook signing secrets and API keys don't visually collide.
 */

const BRAND = "ack";
const PREFIX_BYTES = 8;   // base32(8) = 13 chars after stripping padding
const PREFIX_LEN = 13;
const SECRET_BYTES = 20;  // base32(20) = 32 chars exact, no padding
const SECRET_LEN = 32;
const HASH_LEN = 64;      // SHA-256 hex

export type GeneratedKey = {
  /** Full issued string — show this to the user EXACTLY ONCE. */
  plaintext: string;
  /** First {@link PREFIX_LEN} base32 chars (without the `ack_` brand). UNIQUE in DB. */
  prefix: string;
  /** Last {@link SECRET_LEN} base32 chars. NEVER stored. */
  secret: string;
  /** Hex HMAC. THIS is what goes in `ApiKey.hash`. */
  hash: string;
};

function hmacKey(): Buffer {
  // Same posture as recovery codes (UserTotp) — defence-in-depth: a leak
  // of the DB row alone doesn't yield working credentials, you'd also
  // need ENCRYPTION_KEY. In tests we fall back to NEXTAUTH_SECRET so the
  // suite doesn't require a separate env var.
  const key = process.env.ENCRYPTION_KEY ?? process.env.NEXTAUTH_SECRET;
  if (!key) {
    throw new Error("API key signing requires ENCRYPTION_KEY (or NEXTAUTH_SECRET in tests)");
  }
  return Buffer.from(key, "utf8");
}

export function computeHash(prefix: string, secret: string): string {
  return createHmac("sha256", hmacKey()).update(`${prefix}.${secret}`).digest("hex");
}

export function generateApiKey(): GeneratedKey {
  // base32 lower-cases everything; key strings end up entirely lowercase
  // ASCII letters + digits 2..7. Trim trailing `=` padding so the
  // canonical widths above are exact.
  const prefix = base32Encode(randomBytes(PREFIX_BYTES)).replace(/=+$/, "").toLowerCase();
  const secret = base32Encode(randomBytes(SECRET_BYTES)).replace(/=+$/, "").toLowerCase();
  // Defensive sanity — the constants above should make these exact, but
  // if a future code change drifts the byte counts we'd rather throw at
  // generation time than ship malformed keys.
  if (prefix.length !== PREFIX_LEN || secret.length !== SECRET_LEN) {
    throw new Error(
      `internal: api key width drift (prefix=${prefix.length}, secret=${secret.length})`,
    );
  }
  const plaintext = `${BRAND}_${prefix}_${secret}`;
  return { plaintext, prefix, secret, hash: computeHash(prefix, secret) };
}

export type ParsedKey = { prefix: string; secret: string };

/**
 * Parse a presented bearer token. Returns null if the shape is wrong —
 * caller treats this as an auth failure without further DB lookup.
 *
 * Tolerant of surrounding whitespace and case (real-world copy-paste).
 * Brand match is lowercased; the body is normalised to lower.
 */
export function parseApiKey(input: string | undefined | null): ParsedKey | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  const bareCandidate = trimmed.startsWith("bearer ")
    ? trimmed.slice("bearer ".length).trim()
    : trimmed;
  if (!bareCandidate) return null;
  const parts = bareCandidate.split("_");
  if (parts.length !== 3) return null;
  const [brand, prefix, secret] = parts;
  if (brand !== BRAND) return null;
  if (prefix.length !== PREFIX_LEN) return null;
  if (secret.length !== SECRET_LEN) return null;
  // Base32 alphabet (RFC 4648, lowercased) — guards against odd
  // characters slipping through and being passed to the HMAC. timing
  // is irrelevant here because this is purely shape validation; the
  // sensitive compare happens against the stored hash.
  const base32 = /^[a-z2-7]+$/;
  if (!base32.test(prefix) || !base32.test(secret)) return null;
  return { prefix, secret };
}

/**
 * Constant-time hash compare. Returns false on length mismatch (which
 * `timingSafeEqual` would otherwise throw on) so callers can use it as a
 * boolean without try/catch.
 */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (a.length !== HASH_LEN) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export { PREFIX_LEN, SECRET_LEN, BRAND };
