export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Standard request-id token. Short, URL-safe, log-friendly.
 *
 * Uses Web Crypto's `crypto.randomUUID()` rather than `node:crypto` so the
 * same module compiles for the Edge runtime (Next.js middleware) and the
 * Node runtime (route handlers, lib code).
 */
export function generateRequestId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Read request-id from a request's headers, or mint a new one. */
export function requestIdFromHeaders(h: Headers): string {
  const existing = h.get(REQUEST_ID_HEADER);
  if (existing && existing.length > 0 && existing.length <= 128) return existing;
  return generateRequestId();
}
