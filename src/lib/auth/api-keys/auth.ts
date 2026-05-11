import { NextResponse, type NextRequest } from "next/server";
import { reportError } from "@/lib/observability";
import { clientIpFromHeaders, rateLimit, tooManyRequestsResponse } from "@/lib/ratelimit";
import { parseApiKey } from "./secret";
import { authenticateApiKey, recordAuthFailure, type AuthenticatedApiKey } from "./store";
import { scopeAllows, type ApiScope } from "./scopes";

/**
 * Handler wrapper that authenticates an incoming request via the
 * `Authorization: Bearer ack_<prefix>_<secret>` header. On success, the
 * inner handler receives the resolved auth context; on failure, the
 * wrapper returns a 401 (no auth context to reason about) or 403
 * (authenticated but lacking the required scope).
 *
 * Used by every `/api/v1/*` route. Distinct from the NextAuth session
 * `auth()` helper — these surfaces are designed for programmatic
 * access from outside the browser session lane.
 *
 * Rate-limited per-IP at the auth point (50/min) so a brute-force
 * probe against the prefix space costs an attacker the same as the
 * sign-in surface (item 11 — `auth` scope) without us having to
 * reach the per-key path for every failed attempt.
 */

export type ApiKeyContext = AuthenticatedApiKey & {
  ip: string;
};

export type ApiKeyHandler = (
  req: NextRequest,
  ctx: ApiKeyContext,
) => Promise<Response> | Response;

const WWW_AUTH = 'Bearer realm="Acumon API", error="invalid_token"';

function unauthorised(message: string): Response {
  return new NextResponse(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": WWW_AUTH,
    },
  });
}

function forbidden(message: string): Response {
  return new NextResponse(JSON.stringify({ error: message }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

export type WithApiKeyOptions = {
  /** Required scope for this handler. The wrapper enforces it. */
  scope: ApiScope;
  /** Optional override for the per-IP rate limit (default 50/min). */
  ipRateLimit?: { limit: number; windowSeconds: number };
};

export function withApiKey(opts: WithApiKeyOptions, handler: ApiKeyHandler) {
  return async function authenticatedHandler(req: NextRequest): Promise<Response> {
    const ip = clientIpFromHeaders(req.headers);

    // Per-IP rate-limit BEFORE auth so an attacker probing the prefix
    // space can't blow up the audit chain with one row per failed
    // attempt.
    const rl = await rateLimit({
      identity: { kind: "ip", value: ip },
      scope: "api-key-auth",
      limit: opts.ipRateLimit?.limit ?? 50,
      windowSeconds: opts.ipRateLimit?.windowSeconds ?? 60,
    });
    if (!rl.allowed) return tooManyRequestsResponse(rl);

    const header = req.headers.get("authorization");
    const parsed = parseApiKey(header);
    if (!parsed) return unauthorised("authorisation header missing or malformed");

    let auth: AuthenticatedApiKey | null = null;
    try {
      auth = await authenticateApiKey({ prefix: parsed.prefix, secret: parsed.secret, presentedIp: ip });
    } catch (err) {
      reportError(err, { route: "api-keys/auth" }, "api-key auth lookup failed");
      return unauthorised("internal authentication error");
    }
    if (!auth) {
      // We don't know the tenant yet (the prefix didn't resolve OR the
      // hash didn't match OR the creator went inactive). Skip the
      // audit write — there's no tenant chain to write to. The
      // per-IP rate limit above provides the brute-force defence.
      return unauthorised("invalid api key");
    }

    if (!scopeAllows(auth.apiKey.scopes, auth.membership.role, opts.scope)) {
      // Authenticated but the wrong scope — audit on the resolved
      // tenant. Useful incident-response signal: a key trying to
      // access a surface it isn't scoped for.
      try {
        await recordAuthFailure({
          tenantId: auth.membership.tenantId,
          prefix: auth.apiKey.prefix,
          reason: "scope-denied",
          ip,
        });
      } catch (err) {
        reportError(err, { route: "api-keys/auth-failure" });
      }
      return forbidden(`scope '${opts.scope}' not granted by this api key`);
    }

    return handler(req, { ...auth, ip });
  };
}
