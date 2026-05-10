/**
 * Post-PRD hardening — API rate limiting + brute-force protection
 * (`src/lib/ratelimit/`).
 *
 * Coverage:
 *  - Fixed-window counter enforces the limit (N allowed, N+1 denied).
 *  - Window reset: after the window elapses, count restarts at 1.
 *  - Per-key isolation: different scopes / identities don't interfere.
 *  - Concurrent requests under contention are atomic — no double-pass.
 *  - Audit-event throttling — at most one RATE_LIMIT_EXCEEDED per (key, hour).
 *  - clientIpFromHeaders prefers x-forwarded-for first hop, then x-real-ip,
 *    cf-connecting-ip, fly-client-ip, x-vercel-forwarded-for, then "unknown".
 *  - tooManyRequestsResponse returns a 429 with Retry-After + X-RateLimit-* headers.
 *  - Stale-bucket reaper deletes rows older than 7 days, leaves fresh ones.
 *  - Fail-open semantics: a malformed identity still yields a sensible result
 *    (here we only verify the happy-path; the catch branch is logged-but-allowed
 *    and is exercised in production via the reportError shim, not the test DB).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { superDb } from "@/lib/db";
import {
  rateLimit,
  rateLimitKey,
  clientIpFromHeaders,
  tooManyRequestsResponse,
  reapStaleRateLimitBuckets,
  type RateLimitIdentity,
} from "@/lib/ratelimit";
import { createTestTenant, createTestUserAndMembership } from "../helpers/fixtures";

function ipIdentity(value?: string): RateLimitIdentity {
  return { kind: "ip", value: value ?? `1.2.3.${Math.floor(Math.random() * 250)}` };
}

async function freshKey(prefix: string) {
  // Use the test's UUID as the identity so each test gets its own bucket.
  return rateLimitKey({ kind: "ip", value: `${prefix}-${randomUUID()}` }, "default");
}

describe("rate limit — fixed-window counter", () => {
  beforeEach(async () => {
    // Tests use unique identities so cross-test interference is impossible,
    // but still scrub stale rows so the bucket count stays small in CI.
    await superDb.rateLimitBucket.deleteMany({
      where: { updatedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    });
  });

  it("enforces the limit — first N pass, N+1 is denied", async () => {
    const identity = ipIdentity();
    const limit = 3;
    const results = [];
    for (let i = 0; i < limit + 1; i++) {
      results.push(
        await rateLimit({ identity, scope: "default", limit, windowSeconds: 60 }),
      );
    }
    expect(results[0].allowed).toBe(true);
    expect(results[0].count).toBe(1);
    expect(results[0].remaining).toBe(2);
    expect(results[1].allowed).toBe(true);
    expect(results[2].allowed).toBe(true);
    expect(results[3].allowed).toBe(false);
    expect(results[3].count).toBe(4);
    expect(results[3].remaining).toBe(0);
    expect(results[3].retryAfter).toBeGreaterThan(0);
    expect(results[3].limit).toBe(3);
  });

  it("isolates buckets per (identity, scope) — different scopes don't share", async () => {
    const identity = ipIdentity();
    const a = await rateLimit({ identity, scope: "default", limit: 1, windowSeconds: 60 });
    const b = await rateLimit({ identity, scope: "default", limit: 1, windowSeconds: 60 });
    const c = await rateLimit({ identity, scope: "search", limit: 1, windowSeconds: 60 });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(false); // same scope, hit
    expect(c.allowed).toBe(true);  // different scope, fresh bucket
  });

  it("isolates buckets per identity — different IPs don't share", async () => {
    const a = await rateLimit({
      identity: ipIdentity("10.0.0.1"), scope: "default", limit: 1, windowSeconds: 60,
    });
    const b = await rateLimit({
      identity: ipIdentity("10.0.0.2"), scope: "default", limit: 1, windowSeconds: 60,
    });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });

  it("resets the window after windowSeconds elapses (simulated by manually backdating)", async () => {
    const identity = ipIdentity();
    const a = await rateLimit({ identity, scope: "default", limit: 1, windowSeconds: 60 });
    expect(a.allowed).toBe(true);
    const b = await rateLimit({ identity, scope: "default", limit: 1, windowSeconds: 60 });
    expect(b.allowed).toBe(false);

    // Backdate windowStart so the bucket is "stale" — the next call should
    // observe (now - windowStart) >= windowSeconds and reset to count=1.
    const key = rateLimitKey(identity, "default");
    await superDb.rateLimitBucket.update({
      where: { key },
      data: { windowStart: new Date(Date.now() - 120_000) },
    });

    const c = await rateLimit({ identity, scope: "default", limit: 1, windowSeconds: 60 });
    expect(c.allowed).toBe(true);
    expect(c.count).toBe(1);
  });

  it("counts concurrent requests atomically — no double-pass at the boundary", async () => {
    const identity = ipIdentity();
    const limit = 5;
    // Fire 20 requests in parallel. Exactly `limit` should be allowed.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        rateLimit({ identity, scope: "default", limit, windowSeconds: 60 }),
      ),
    );
    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;
    expect(allowed).toBe(limit);
    expect(denied).toBe(20 - limit);
  });

  it("retryAfter is positive and bounded by the window length", async () => {
    const identity = ipIdentity();
    await rateLimit({ identity, scope: "default", limit: 1, windowSeconds: 30 });
    const denied = await rateLimit({ identity, scope: "default", limit: 1, windowSeconds: 30 });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
    expect(denied.retryAfter).toBeLessThanOrEqual(30);
  });
});

describe("rate limit — audit-event throttling", () => {
  it("writes RATE_LIMIT_EXCEEDED at most once per (key, hour) when tenant is supplied", async () => {
    const tenant = await createTestTenant();
    const { membership } = await createTestUserAndMembership(tenant.id, { role: "USER" });
    const identity = { kind: "membership" as const, value: membership.id };

    // Drive 6 requests against a limit of 2 — 4 of them are denied.
    for (let i = 0; i < 6; i++) {
      await rateLimit({
        identity,
        scope: "default",
        limit: 2,
        windowSeconds: 60,
        tenantId: tenant.id,
        membershipId: membership.id,
      });
    }

    // Wait briefly for the fire-and-forget audit write to settle.
    await new Promise((r) => setTimeout(r, 250));

    const events = await superDb.auditEvent.findMany({
      where: { tenantId: tenant.id, eventType: "RATE_LIMIT_EXCEEDED" },
      orderBy: { seq: "asc" },
    });
    expect(events.length).toBe(1);
    expect((events[0].payload as { scope: string }).scope).toBe("default");
    expect((events[0].payload as { limit: number }).limit).toBe(2);
    expect(events[0].actorMembershipId).toBe(membership.id);

    // The bucket row must have its lastAuditAt populated.
    const key = rateLimitKey(identity, "default");
    const bucket = await superDb.rateLimitBucket.findUnique({ where: { key } });
    expect(bucket?.lastAuditAt).not.toBeNull();
  });

  it("does NOT write an audit event when no tenant is supplied", async () => {
    // Capture audit-event count before — IP-only buckets shouldn't add events.
    const tenant = await createTestTenant();
    const before = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "RATE_LIMIT_EXCEEDED" },
    });

    const identity = ipIdentity();
    await rateLimit({ identity, scope: "default", limit: 1, windowSeconds: 60 });
    await rateLimit({ identity, scope: "default", limit: 1, windowSeconds: 60 });
    await rateLimit({ identity, scope: "default", limit: 1, windowSeconds: 60 });
    await new Promise((r) => setTimeout(r, 200));

    const after = await superDb.auditEvent.count({
      where: { tenantId: tenant.id, eventType: "RATE_LIMIT_EXCEEDED" },
    });
    expect(after).toBe(before);
  });
});

describe("clientIpFromHeaders", () => {
  it("prefers the first hop of x-forwarded-for", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1, 10.0.0.2" });
    expect(clientIpFromHeaders(h)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip when xff is absent", () => {
    const h = new Headers({ "x-real-ip": "198.51.100.7" });
    expect(clientIpFromHeaders(h)).toBe("198.51.100.7");
  });

  it("uses cf-connecting-ip when only Cloudflare's header is present", () => {
    const h = new Headers({ "cf-connecting-ip": "192.0.2.4" });
    expect(clientIpFromHeaders(h)).toBe("192.0.2.4");
  });

  it("falls back to fly-client-ip", () => {
    const h = new Headers({ "fly-client-ip": "192.0.2.99" });
    expect(clientIpFromHeaders(h)).toBe("192.0.2.99");
  });

  it("returns 'unknown' when no forwarding header is set", () => {
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });
});

describe("tooManyRequestsResponse", () => {
  it("returns a 429 with Retry-After and X-RateLimit-* headers", () => {
    const res = tooManyRequestsResponse({
      allowed: false,
      remaining: 0,
      count: 11,
      limit: 10,
      resetAt: 1_700_000_000,
      retryAfter: 30,
      key: "ip:1.2.3.4:default",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBe("1700000000");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("includes a JSON body the client can parse without reading headers", async () => {
    const res = tooManyRequestsResponse({
      allowed: false, remaining: 0, count: 6, limit: 5, resetAt: 1, retryAfter: 12, key: "k",
    });
    const body = (await res.json()) as { error: string; retryAfter: number; limit: number };
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.retryAfter).toBe(12);
    expect(body.limit).toBe(5);
  });
});

describe("reapStaleRateLimitBuckets", () => {
  it("deletes rows older than 7 days and leaves fresh ones intact", async () => {
    const freshKey1 = await freshKey("reap-fresh");
    const staleKey1 = await freshKey("reap-stale");

    // Create one fresh + one stale bucket.
    await superDb.rateLimitBucket.create({
      data: {
        key: freshKey1,
        windowStart: new Date(),
        count: 1,
      },
    });
    await superDb.rateLimitBucket.create({
      data: {
        key: staleKey1,
        windowStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        count: 99,
      },
    });
    // updatedAt is auto-managed by Prisma's @updatedAt — backdate via
    // raw SQL so the reaper picks the stale row up.
    await superDb.$executeRawUnsafe(
      `UPDATE "RateLimitBucket" SET "updatedAt" = $1 WHERE "key" = $2`,
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      staleKey1,
    );

    const result = await reapStaleRateLimitBuckets();
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const freshStill = await superDb.rateLimitBucket.findUnique({ where: { key: freshKey1 } });
    expect(freshStill).not.toBeNull();
    const staleGone = await superDb.rateLimitBucket.findUnique({ where: { key: staleKey1 } });
    expect(staleGone).toBeNull();
  });
});
