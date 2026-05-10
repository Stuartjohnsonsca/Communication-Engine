import { createHmac, timingSafeEqual } from "node:crypto";
import { base32Decode } from "./base32";

/**
 * RFC 6238 TOTP — HMAC-SHA1, 30-second step, 6 digits. Hard-coded to the
 * defaults that every authenticator app (Google Authenticator, Authy,
 * 1Password, Bitwarden, Microsoft Authenticator) supports without
 * configuration. Drift window: ±1 step (so codes minted in the previous or
 * next 30s slot are accepted) to absorb minor client/server clock skew.
 */

export const STEP_SECONDS = 30;
export const DIGITS = 6;
export const DRIFT_STEPS = 1;

/**
 * Generate the TOTP for a given base32 secret at a specific UNIX time.
 * The default `atSecondsUtc` is now-UTC; tests pass a fixed value to
 * verify against RFC 6238 vectors.
 */
export function generateTotp(base32Secret: string, atSecondsUtc?: number): string {
  const t = atSecondsUtc ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(t / STEP_SECONDS);
  return hotp(base32Decode(base32Secret), counter);
}

/**
 * Constant-time verify of a 6-digit code against the secret, accepting the
 * current step and ±DRIFT_STEPS neighbouring steps. Returns the matching
 * step offset (-1, 0, +1) on success so callers can detect codes that were
 * already valid at the prior step (replay-prevention beyond what we do).
 * Returns null on no match.
 */
export function verifyTotp(
  base32Secret: string,
  code: string,
  opts?: { atSecondsUtc?: number; drift?: number },
): { matchedStep: number } | null {
  if (!/^\d{6}$/.test(code)) return null;
  const drift = opts?.drift ?? DRIFT_STEPS;
  const t = opts?.atSecondsUtc ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(t / STEP_SECONDS);
  const keyBytes = base32Decode(base32Secret);
  const want = Buffer.from(code, "utf8");
  for (let i = -drift; i <= drift; i += 1) {
    const candidate = Buffer.from(hotp(keyBytes, counter + i), "utf8");
    if (candidate.length === want.length && timingSafeEqual(candidate, want)) {
      return { matchedStep: i };
    }
  }
  return null;
}

/**
 * RFC 4226 HOTP — HMAC-SHA1, dynamic-truncation, modulo 10^DIGITS.
 * Counter encoded as 8-byte big-endian.
 */
export function hotp(keyBytes: Uint8Array, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  // 8-byte big-endian. JavaScript Number is safe to ~2^53; for counter
  // values that fit in 32 bits (Number.MAX_SAFE_INTEGER >> 2^32 step
  // = ~5.7 trillion years at 30s/step) we never need the upper word.
  // Write the low 32 bits at offset 4; high 32 bits stay zero.
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", Buffer.from(keyBytes)).update(counterBuf).digest();
  // RFC 4226 §5.3 dynamic truncation
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const mod = 10 ** DIGITS;
  return String(bin % mod).padStart(DIGITS, "0");
}
