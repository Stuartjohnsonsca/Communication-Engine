import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_ID_HEADER, requestIdFromHeaders } from "@/lib/observability/request-id";
import { buildCspHeader, generateCspNonce } from "@/lib/security/csp";

/**
 * Edge middleware: ensures every inbound request carries an `x-request-id`
 * AND a per-request CSP nonce, surfacing both on the response so a
 * browser/curl/Railway log line can be correlated end-to-end.
 *
 * The nonce drops `script-src 'unsafe-inline'` for modern browsers — Next 15
 * App Router reads `x-nonce` from request headers and threads it into the
 * hydration `<script>` tags it emits, and `'strict-dynamic'` extends trust
 * to dynamically-loaded chunk scripts. Legacy browsers fall back to
 * `'unsafe-inline'` which is still listed; per the CSP spec, browsers that
 * honour `'strict-dynamic'` ignore `'unsafe-inline'` automatically.
 *
 * AsyncLocalStorage isn't available across the Edge/runtime boundary,
 * so the rest of the app reads ids and nonces from `request.headers`.
 */
export function middleware(req: NextRequest) {
  const requestId = requestIdFromHeaders(req.headers);
  const nonce = generateCspNonce();

  const csp = buildCspHeader(nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  requestHeaders.set("x-nonce", nonce);
  // Per Next 15 CSP guidance, set CSP on the request headers too so the
  // internal rendering path correlates the nonce with the active policy.
  requestHeaders.set("Content-Security-Policy", csp);
  // Mirror the active pathname into a request header so server components
  // can read it. Next 15 App Router does not surface the active pathname
  // to server components directly; layouts use this for redirect decisions
  // (e.g. the 2FA gate allowlists certain paths to avoid redirect loops).
  requestHeaders.set("x-pathname", req.nextUrl.pathname);

  const res = NextResponse.next({
    request: { headers: requestHeaders },
  });
  res.headers.set(REQUEST_ID_HEADER, requestId);
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  // Skip Next.js internals + static assets. API + page routes get the
  // request-id, x-nonce, and CSP headers.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
