/**
 * API rate limiting + brute-force protection.
 *
 * Backed by the `RateLimitBucket` table (migration 31). Fixed-window
 * counter: one row per key, atomic UPSERT per check. The whole transition
 * happens in a single Postgres statement so two concurrent requests can't
 * both pass through during a window-boundary race.
 *
 * Identities are one of:
 *   - "ip"          — public/unauthenticated endpoints
 *   - "membership"  — authenticated, scoped to a single Membership
 *   - "tenant"      — tenant-wide ceiling (sum across the firm)
 *   - "auth"        — sign-in / OTP-verify per email
 *
 * Scopes are short labels for the surface being limited: "sign-in", "draft",
 * "search", "oauth-callback", "cron", "default".
 *
 * Usage:
 *
 *   import { rateLimit } from "@/lib/ratelimit";
 *   const result = await rateLimit({
 *     identity: { kind: "ip", value: clientIpFromHeaders(req.headers) },
 *     scope: "sign-in",
 *     limit: 10,
 *     windowSeconds: 60,
 *   });
 *   if (!result.allowed) return tooManyRequestsResponse(result);
 *
 * Always returns; never throws. A transient DB error logs via `reportError`
 * and fails OPEN (allows the request) — the rate limiter must never make the
 * application less available than it would have been without it.
 */
import { randomUUID } from "node:crypto";
import { superDb } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { reportError, log } from "@/lib/observability";

export type RateLimitIdentity = {
  kind: "ip" | "membership" | "tenant" | "auth";
  value: string;
};

export type RateLimitScope =
  | "sign-in"
  | "draft"
  | "search"
  | "ai-judge"
  | "oauth-callback"
  | "cron"
  | "health"
  | "notifications"
  | "vote"
  | "totp-enroll"
  | "totp-disable"
  | "totp-challenge"
  | "api-key-auth"
  | "default";

export type RateLimitOpts = {
  identity: RateLimitIdentity;
  scope: RateLimitScope;
  /** Maximum requests within `windowSeconds`. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Optional tenant id for audit-event attribution on overflow. When omitted
   * (pre-tenant-resolution endpoints), no audit event is written and the
   * overflow surfaces via the structured log only.
   */
  tenantId?: string;
  /** Optional membership id for audit-event actor attribution. */
  membershipId?: string;
};

export type RateLimitResult = {
  allowed: boolean;
  /** Remaining requests in the current window after this check. Never negative. */
  remaining: number;
  /** Number of requests counted (including this one) in the current window. */
  count: number;
  /** Window cap. */
  limit: number;
  /** Unix-seconds at which the current window resets. */
  resetAt: number;
  /** Seconds until the window resets — what we send in Retry-After on 429. */
  retryAfter: number;
  /** Resolved key for the audit/log breadcrumb. */
  key: string;
};

const AUDIT_THROTTLE_MS = 60 * 60 * 1000;

export function rateLimitKey(identity: RateLimitIdentity, scope: RateLimitScope): string {
  return `${identity.kind}:${identity.value}:${scope}`;
}

/**
 * Atomic fixed-window counter using a single SQL upsert. The window-roll
 * happens inside the UPDATE branch so concurrent requests are serialised by
 * row-level lock — there is no read-modify-write race.
 */
export async function rateLimit(opts: RateLimitOpts): Promise<RateLimitResult> {
  const key = rateLimitKey(opts.identity, opts.scope);
  const now = new Date();
  const windowMs = opts.windowSeconds * 1000;

  let count = 1;
  let windowStart = now;

  try {
    const rows = await superDb.$queryRawUnsafe<
      { count: number; windowStart: Date; lastAuditAt: Date | null }[]
    >(
      `
      INSERT INTO "RateLimitBucket" ("id", "key", "windowStart", "count", "updatedAt")
      VALUES ($4, $1, $2::timestamp, 1, $2::timestamp)
      ON CONFLICT ("key") DO UPDATE
      SET
        "count" = CASE
          WHEN $2::timestamp - "RateLimitBucket"."windowStart" >= ($3 || ' seconds')::interval
          THEN 1
          ELSE "RateLimitBucket"."count" + 1
        END,
        "windowStart" = CASE
          WHEN $2::timestamp - "RateLimitBucket"."windowStart" >= ($3 || ' seconds')::interval
          THEN $2::timestamp
          ELSE "RateLimitBucket"."windowStart"
        END,
        "updatedAt" = $2::timestamp
      RETURNING "count", "windowStart", "lastAuditAt";
      `,
      key,
      now,
      String(opts.windowSeconds),
      randomUUID(),
    );

    if (rows.length > 0) {
      count = rows[0].count;
      windowStart = new Date(rows[0].windowStart);
    }
  } catch (e) {
    // Fail OPEN. Rate limiting must never make us less available — a
    // misconfigured DB shouldn't lock everyone out of the product.
    reportError(e, {
      route: "lib/ratelimit",
      extra: { key, scope: opts.scope, identity: opts.identity.kind },
    }, "rate-limit check failed; failing open");
    return {
      allowed: true,
      remaining: opts.limit,
      count: 0,
      limit: opts.limit,
      resetAt: Math.floor((now.getTime() + windowMs) / 1000),
      retryAfter: opts.windowSeconds,
      key,
    };
  }

  const resetAtMs = windowStart.getTime() + windowMs;
  const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - now.getTime()) / 1000));
  const allowed = count <= opts.limit;
  const remaining = Math.max(0, opts.limit - count);

  const result: RateLimitResult = {
    allowed,
    remaining,
    count,
    limit: opts.limit,
    resetAt: Math.floor(resetAtMs / 1000),
    retryAfter: retryAfterSec,
    key,
  };

  if (!allowed) {
    log.warn("rate limit exceeded", {
      key,
      scope: opts.scope,
      identity: opts.identity.kind,
      count,
      limit: opts.limit,
      tenantId: opts.tenantId,
    });
    // Audit-event throttle — one event per (key, hour) so a sustained attack
    // can't fill the chain. Bumped via a follow-up UPDATE rather than a
    // second column on the upsert above (keeps the hot-path SQL simple).
    if (opts.tenantId) {
      void recordAuditIfDue({
        key,
        tenantId: opts.tenantId,
        membershipId: opts.membershipId,
        scope: opts.scope,
        count,
        limit: opts.limit,
        windowSeconds: opts.windowSeconds,
      });
    }
  }

  return result;
}

async function recordAuditIfDue(input: {
  key: string;
  tenantId: string;
  membershipId?: string;
  scope: RateLimitScope;
  count: number;
  limit: number;
  windowSeconds: number;
}) {
  try {
    const now = new Date();
    const updated = await superDb.$queryRawUnsafe<{ id: string }[]>(
      `
      UPDATE "RateLimitBucket"
      SET "lastAuditAt" = $1::timestamp
      WHERE "key" = $2
        AND ("lastAuditAt" IS NULL OR $1::timestamp - "lastAuditAt" >= ($3 || ' milliseconds')::interval)
      RETURNING "id";
      `,
      now,
      input.key,
      String(AUDIT_THROTTLE_MS),
    );
    if (updated.length === 0) return; // already audited this hour

    await writeAuditEvent({
      tenantId: input.tenantId,
      eventType: "RATE_LIMIT_EXCEEDED",
      actorMembershipId: input.membershipId ?? null,
      subjectType: "RateLimitBucket",
      subjectId: updated[0].id,
      payload: {
        key: input.key,
        scope: input.scope,
        count: input.count,
        limit: input.limit,
        windowSeconds: input.windowSeconds,
      },
    });
  } catch (e) {
    // Audit-event failure must not bubble — we already logged the warning,
    // and a sustained attack still gets the structured-log breadcrumb.
    reportError(e, { route: "lib/ratelimit/audit", extra: { key: input.key } });
  }
}

/**
 * Standard 429 response. Sets Retry-After (seconds) and the X-RateLimit-*
 * headers most JS clients understand. The body is a small JSON shape so
 * fetch() consumers can introspect without parsing headers.
 */
export function tooManyRequestsResponse(result: RateLimitResult, message?: string) {
  return new Response(
    JSON.stringify({
      error: "rate_limit_exceeded",
      message: message ?? "Too many requests. Slow down and try again in a moment.",
      retryAfter: result.retryAfter,
      limit: result.limit,
      resetAt: result.resetAt,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(result.retryAfter),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(result.resetAt),
      },
    },
  );
}

/**
 * Extract a usable client IP from request headers. Trusts the standard
 * forwarding headers in this order: `x-forwarded-for` (first hop),
 * `x-real-ip`, `cf-connecting-ip` (Cloudflare), `fly-client-ip` (Fly.io),
 * `x-vercel-forwarded-for`. Falls back to "unknown" so a single bucket
 * absorbs every request that lacks an IP (still rate-limited as a group).
 *
 * Note: in front of a reverse proxy we trust the proxy's headers; behind
 * a load balancer with `x-forwarded-for` chaining we pick the leftmost
 * address (the original client). If the deployment ever sits behind an
 * untrusted proxy, swap to the rightmost trusted hop instead.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fly = headers.get("fly-client-ip");
  if (fly) return fly.trim();
  const vercel = headers.get("x-vercel-forwarded-for");
  if (vercel) {
    const first = vercel.split(",")[0].trim();
    if (first) return first;
  }
  return "unknown";
}

/**
 * Shorthand: per-IP limit. Most public/unauthenticated routes use this.
 */
export async function rateLimitByIp(
  req: Request,
  scope: RateLimitScope,
  limit: number,
  windowSeconds: number,
) {
  return rateLimit({
    identity: { kind: "ip", value: clientIpFromHeaders(req.headers) },
    scope,
    limit,
    windowSeconds,
  });
}

/**
 * Shorthand: per-Membership limit. Authenticated routes use this once the
 * tenant context is resolved — the tenantId is threaded through for audit
 * attribution on overflow.
 */
export async function rateLimitByMembership(
  membershipId: string,
  tenantId: string,
  scope: RateLimitScope,
  limit: number,
  windowSeconds: number,
) {
  return rateLimit({
    identity: { kind: "membership", value: membershipId },
    scope,
    limit,
    windowSeconds,
    tenantId,
    membershipId,
  });
}

/**
 * Stale-bucket garbage collection. Called from the lifecycle-sweep cron —
 * any row whose `updatedAt` is more than 7 days old is reaped. A subsequent
 * request just re-creates the row.
 */
export async function reapStaleRateLimitBuckets(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const deleted = await superDb.rateLimitBucket.deleteMany({
    where: { updatedAt: { lt: cutoff } },
  });
  return { deleted: deleted.count };
}
