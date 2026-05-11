/**
 * Per-request CSP construction.
 *
 * The static security headers in `next.config.ts` cover the request-agnostic
 * directives (HSTS, X-Frame-Options, Permissions-Policy, etc.). CSP needs
 * a fresh nonce per request so it's set from middleware instead — see
 * `src/middleware.ts`.
 *
 * Why `'strict-dynamic'` + `'nonce-<value>'`:
 *   - Next.js 15 App Router emits hydration `<script>` tags whose nonces it
 *     reads from the `x-nonce` request header set by middleware. With a
 *     nonce in `script-src`, every other inline `<script>` without a
 *     matching nonce is blocked, eliminating the classic XSS-inject vector.
 *   - `'strict-dynamic'` extends trust transitively: a script that loaded
 *     via a nonced tag can load additional scripts (Next's runtime chunks)
 *     without needing per-chunk nonces. This is the modern recommended
 *     pattern (CSP Level 3).
 *   - `'unsafe-inline'` remains as a fallback for browsers that don't
 *     understand `'strict-dynamic'`. Per the CSP spec, browsers that
 *     understand `'strict-dynamic'` IGNORE `'unsafe-inline'` automatically,
 *     so this provides graceful degradation without weakening modern
 *     browsers.
 *   - `'self'` and `https:` follow the same fallback rule: ignored by
 *     `'strict-dynamic'`-aware browsers, honoured by older ones.
 *
 * Style-src keeps `'unsafe-inline'` for Tailwind + next/font's runtime style
 * injection. A future tightening could nonce styles too, but the
 * XSS surface for style-src is narrower (CSS expression-attacks are
 * effectively defunct in modern browsers).
 */

const NONCE_BYTES = 16; // 128 bits — meets the CSP-3 minimum.

/**
 * Generate a fresh base64 CSP nonce. Uses Web Crypto so it works in the
 * Edge runtime (Node-compatible too — `crypto` is globally available in
 * modern Node).
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  // base64-encode without using Buffer (edge runtime). Build a binary
  // string then btoa() it. Each byte → one char; safe for arbitrary bytes
  // because we're sticking to the 0–255 range of String.fromCharCode.
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/**
 * Build the Content-Security-Policy header value with the supplied nonce
 * embedded. Caller is responsible for setting it on the response.
 */
export function buildCspHeader(nonce: string): string {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'strict-dynamic' 'nonce-${nonce}' 'unsafe-inline' https:`,
    "connect-src 'self' https:",
    "upgrade-insecure-requests",
  ];
  return directives.join("; ");
}

/** Re-export for tests + the rare server component that needs the nonce. */
export const NONCE_HEADER = "x-nonce";
