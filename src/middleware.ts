import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_ID_HEADER, requestIdFromHeaders } from "@/lib/observability/request-id";

/**
 * Edge middleware: ensures every inbound request carries an `x-request-id`
 * and surfaces it on the response so a browser/curl/Railway log line can be
 * correlated end-to-end.
 *
 * Mints a fresh id when the upstream client didn't send one. Preserves any
 * id already on the request (so a client trace can be threaded through).
 *
 * Note: AsyncLocalStorage isn't available across the Edge/runtime boundary,
 * so the rest of the app reads the id from `request.headers` (or from this
 * response header on the client side). The structured logger does the same:
 * it accepts a `requestId` field rather than pulling from a global.
 */
export function middleware(req: NextRequest) {
  const requestId = requestIdFromHeaders(req.headers);

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  // Mirror the active pathname into a request header so server components
  // can read it. Next 15 App Router does not surface the active pathname
  // to server components directly; layouts use this for redirect decisions
  // (e.g. the 2FA gate allowlists certain paths to avoid redirect loops).
  requestHeaders.set("x-pathname", req.nextUrl.pathname);

  const res = NextResponse.next({
    request: { headers: requestHeaders },
  });
  res.headers.set(REQUEST_ID_HEADER, requestId);
  return res;
}

export const config = {
  // Skip Next.js internals + static assets. API + page routes get the
  // request-id header.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
