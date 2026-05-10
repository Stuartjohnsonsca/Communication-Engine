import { randomBytes } from "node:crypto";
import { base32Encode } from "./base32";

/**
 * Generate a 20-byte (160-bit) random secret, encoded as base32 — the
 * default-and-only-supported size for RFC 6238 with SHA-1. 20 bytes is
 * also what every authenticator app expects in the otpauth:// `secret`
 * parameter.
 */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * Build the `otpauth://totp/...` URI that authenticator apps consume. The
 * `account` is typically the User's email; `issuer` is the product name.
 * Both are percent-encoded into the path AND repeated as a query parameter
 * (`issuer=`) — every spec-compliant authenticator app prefers the query
 * form, but a couple of older ones still parse the path label.
 *
 * Format (per Google Authenticator key-uri-format wiki, the de-facto spec):
 *   otpauth://totp/<issuer>:<account>?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30
 */
export function provisioningUri({
  secret,
  account,
  issuer,
}: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Render a 32-char base32 secret in groups of four for manual entry. Most
 * authenticator apps tolerate spaces, but humans transcribe in groups
 * better than as a single 32-character blob.
 */
export function formatForDisplay(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}
